'use strict';
// 原料供应批号流向追溯（只读查询，不改变任何放行 / 标签卷 / 出货 / 处置结论）。
//
// 指定原料及供应批号（或只指定原料、查询“批号未知”），沿当前最新的合法时间线逐时传播：
//   1) 直接投料：加工事件直接使用了该批号原料（批号未知输入单独归为“无法排除”）；
//   2) 前序批次引用：后续加工引用了受影响批次，按引用链逐跳传播；
//   3) 同设备未清洗残留：加工后本批号留在设备残留中，被该设备上之后、下一次已核实
//      清洗（CLEAN）之前的每一次加工并入——已核实清洗截断设备残留。
//
// 命中分两类，受影响对象不漏报、也不会把无法排除的对象误列为安全：
//   CONFIRMED  确定命中：存在一条可核实的传播链，其起点是“该原料 + 该批号”的直接投料；
//   UNRESOLVED 因该原料批号未知而无法排除：传播链起点是“该原料批号未知”的投料
//              （批号未知会沿引用与设备残留继续传播；一个批次只要没有确定证据、
//               但存在未知批号证据，就必须列入无法排除）。
//
// 追溯结果从不持久化：事件更正 / 删除经既有事务校验 + 全量重算后，本查询始终按
// 最新合法时间线重新回放得到。

const DEFAULT_PATH_LIMIT = 30;
const MAX_PATHS = 200;
const TRUNC_MARK = '…（传播路径过多，已截断，受影响对象本身不受截断影响）';

class TraceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'TraceError';
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

// 证据桶：一组传播链（字符串）+ 截断标记
function bucket() {
  return { chains: new Set(), truncated: false };
}
function addChain(b, chain, limit) {
  if (b.truncated) return;
  if (b.chains.size < limit) b.chains.add(chain);
  else if (!b.chains.has(chain)) b.truncated = true;
}
function cloneChains(set) {
  return new Set(set);
}

function baseUnknown(mat) {
  return `原料:${mat.name}(${mat.code})[批号未知]`;
}
function baseKnown(mat, lot) {
  return `原料:${mat.name}(${mat.code})[批号:${lot.lot_code}]`;
}

// ---------- 入口：options = { material_id, lot_id?, lot_code?, path_limit? } ----------
function traceMaterial(db, options) {
  options = options || {};
  const material_id = parseInt(options.material_id, 10);
  if (!Number.isInteger(material_id)) {
    throw new TraceError(400, 'INVALID_REQUEST', '请指定原料 material_id');
  }
  const material = db.prepare(
    'SELECT id, code, name FROM materials WHERE id = ?'
  ).get(material_id);
  if (!material) {
    throw new TraceError(404, 'MATERIAL_NOT_FOUND', `原料 #${material_id} 不存在`);
  }

  let pathLimit = DEFAULT_PATH_LIMIT;
  if (options.path_limit !== undefined && options.path_limit !== null && options.path_limit !== '') {
    pathLimit = parseInt(options.path_limit, 10);
    if (!Number.isInteger(pathLimit) || pathLimit < 1 || pathLimit > MAX_PATHS) {
      throw new TraceError(400, 'INVALID_REQUEST',
        `path_limit 必须是 1~${MAX_PATHS} 之间的整数`);
    }
  }

  const hasLotId = options.lot_id !== undefined && options.lot_id !== null && options.lot_id !== '';
  const hasLotCode = options.lot_code !== undefined && options.lot_code !== null && options.lot_code !== '';
  if (hasLotId && hasLotCode) {
    throw new TraceError(400, 'INVALID_REQUEST', 'lot_id 与 lot_code 只能提供其一');
  }

  let lot = null;
  let mode = 'UNKNOWN'; // UNKNOWN：只指定原料，查“该原料批号未知”的无法排除流向
  if (hasLotId || hasLotCode) {
    mode = 'LOT';
    if (hasLotId) {
      const lot_id = parseInt(options.lot_id, 10);
      if (!Number.isInteger(lot_id)) {
        throw new TraceError(400, 'INVALID_REQUEST', 'lot_id 不合法');
      }
      lot = db.prepare('SELECT * FROM material_lots WHERE id = ?').get(lot_id);
      if (!lot) {
        throw new TraceError(404, 'LOT_NOT_FOUND', `供应批号 #${lot_id} 不存在`);
      }
      if (lot.material_id !== material_id) {
        throw new TraceError(400, 'LOT_MATERIAL_MISMATCH',
          `供应批号 #${lot.id}（${lot.lot_code}）属于原料 #${lot.material_id}，` +
          `与指定原料 #${material_id}（${material.code}）不匹配，已拒绝查询`);
      }
    } else {
      const lot_code = String(options.lot_code).trim();
      if (!lot_code) throw new TraceError(400, 'INVALID_REQUEST', 'lot_code 不能为空');
      lot = db.prepare(
        'SELECT * FROM material_lots WHERE material_id = ? AND lot_code = ?'
      ).get(material_id, lot_code);
      if (!lot) {
        throw new TraceError(404, 'LOT_NOT_FOUND',
          `原料 ${material.code}（${material.name}）下不存在供应批号 "${lot_code}"`);
      }
    }
  }

  const batches = new Map(
    db.prepare('SELECT id, code FROM batches').all().map((b) => [b.id, b])
  );
  const equipment = new Map(
    db.prepare('SELECT id, code, name FROM equipment').all().map((q) => [q.id, q])
  );
  const events = db.prepare(
    `SELECT id, event_time, type, equipment_id, batch_id
       FROM events ORDER BY event_time, id`
  ).all();
  const inputsByEvent = new Map();
  db.prepare(
    `SELECT event_id, material_id, batch_id AS ref_batch_id, material_lot_id
       FROM process_inputs`
  ).all().forEach((r) => {
    if (!inputsByEvent.has(r.event_id)) inputsByEvent.set(r.event_id, []);
    inputsByEvent.get(r.event_id).push(r);
  });

  // 逐时状态
  const batchState = new Map();       // batchId -> { confirmed:bucket, unresolved:bucket, eventTime }
  // 设备残留（仅追踪本原料）：Map<equipId, { confirmed:bucket, unresolved:bucket }>
  const residue = new Map();
  for (const qid of equipment.keys()) {
    residue.set(qid, { confirmed: bucket(), unresolved: bucket() });
  }
  const lastCleanAt = new Map();

  const knownBase = lot ? baseKnown(material, lot) : null;
  const unknownBase = baseUnknown(material);

  for (const ev of events) {
    if (ev.type === 'CLEAN') {
      // 已核实清洗截断该设备的残留（所有原料的残留一并清空，这里只追踪本原料）。
      residue.set(ev.equipment_id, { confirmed: bucket(), unresolved: bucket() });
      lastCleanAt.set(ev.equipment_id, ev.event_time);
      continue;
    }
    if (!ev.batch_id) continue; // 异常数据由提交校验拦截

    const eqCode = (equipment.get(ev.equipment_id) || {}).code || `#${ev.equipment_id}`;
    const out = { confirmed: bucket(), unresolved: bucket() };
    const fresh = { confirmed: bucket(), unresolved: bucket() };

    const addFresh = (kind, chain) => {
      addChain(out[kind], chain, pathLimit);
      addChain(fresh[kind], chain, pathLimit);
    };

    // 同一次加工中同一 (原料,批号) 若重复录入，去重后只产生一条直接依据。
    const seenDirect = new Set();
    const inputs = inputsByEvent.get(ev.id) || [];
    for (const inp of inputs) {
      if (inp.material_id != null) {
        if (inp.material_id !== material_id) continue;
        if (mode === 'LOT' && inp.material_lot_id === lot.id) {
          const key = `K:${knownBase}`;
          if (!seenDirect.has(key)) { seenDirect.add(key); addFresh('confirmed', knownBase); }
        } else if (inp.material_lot_id == null) {
          const key = `U:${unknownBase}`;
          if (!seenDirect.has(key)) { seenDirect.add(key); addFresh('unresolved', unknownBase); }
        }
        // mode==='UNKNOWN' 时：已知批号的输入不算未知；不同批号的已知输入安全排除。
        // mode==='LOT' 且为该原料的其它批号：已知不是目标批号，安全排除。
      } else if (inp.ref_batch_id != null) {
        const ref = batchState.get(inp.ref_batch_id);
        if (!ref) continue; // 非法引用由提交校验拦截
        const refCode = (batches.get(inp.ref_batch_id) || {}).code || `#${inp.ref_batch_id}`;
        for (const chain of ref.confirmed.chains) {
          addFresh('confirmed', `${chain} → 批次引用:${refCode}`);
        }
        for (const chain of ref.unresolved.chains) {
          addFresh('unresolved', `${chain} → 批次引用:${refCode}`);
        }
      }
    }

    // 设备当前残留并入产出（链原样保留：链中已带“设备残留:设备”标记）。
    const carried = residue.get(ev.equipment_id) || { confirmed: bucket(), unresolved: bucket() };
    for (const chain of carried.confirmed.chains) addChain(out.confirmed, chain, pathLimit);
    for (const chain of carried.unresolved.chains) addChain(out.unresolved, chain, pathLimit);

    batchState.set(ev.batch_id, { ...out, eventTime: ev.event_time, equipment_id: ev.equipment_id });

    // 更新设备残留：本次新带入的链追加设备残留标记，原有残留链原样保留。
    const nextRes = { confirmed: bucket(), unresolved: bucket() };
    for (const chain of fresh.confirmed.chains) {
      addChain(nextRes.confirmed, `${chain} → 设备残留:${eqCode}`, pathLimit);
    }
    for (const chain of carried.confirmed.chains) addChain(nextRes.confirmed, chain, pathLimit);
    for (const chain of fresh.unresolved.chains) {
      addChain(nextRes.unresolved, `${chain} → 设备残留:${eqCode}`, pathLimit);
    }
    for (const chain of carried.unresolved.chains) addChain(nextRes.unresolved, chain, pathLimit);
    residue.set(ev.equipment_id, nextRes);
  }

  // ---------- 组装批次结果 ----------
  const eventByBatch = new Map();
  for (const ev of events) {
    if (ev.type === 'PROCESS' && ev.batch_id) eventByBatch.set(ev.batch_id, ev);
  }

  const shipmentRowsByBatch = new Map();
  const allShipments = db.prepare(
    `SELECT id, shipment_code, batch_id, batch_code, ship_qty, status, review_reason,
            shipped_at, shipped_by
       FROM shipments ORDER BY id`
  ).all();
  for (const s of allShipments) {
    if (s.batch_id == null) continue;
    if (!shipmentRowsByBatch.has(s.batch_id)) shipmentRowsByBatch.set(s.batch_id, []);
    shipmentRowsByBatch.get(s.batch_id).push(s);
  }
  const latestDispStmt = db.prepare(
    `SELECT decision, life_status, stale_reason FROM shipment_dispositions
      WHERE shipment_id = ? ORDER BY id DESC LIMIT 1`
  );

  const formatShipmentBrief = (s) => {
    const disp = latestDispStmt.get(s.id);
    return {
      shipment_id: s.id,
      shipment_code: s.shipment_code,
      status: s.status,
      pending_review: s.status === 'PENDING_REVIEW',
      review_reason: s.review_reason || '',
      ship_qty: s.ship_qty,
      shipped_at: s.shipped_at,
      shipped_by: s.shipped_by,
      current_disposition: disp ? {
        decision: disp.decision,
        decision_text: disp.decision === 'CONTINUE' ? '准予继续流转' : '召回',
        life_status: disp.life_status,
        needs_review: disp.life_status === 'STALE',
        stale_reason: disp.stale_reason || ''
      } : null
    };
  };

  // 按“进入该批次的最后一跳”归类传播依据：链尾为“设备残留:X”=经同设备残留进入，
  // 链尾为“批次引用:X”=经前序批次引用进入，其余=直接投料。
  // （链中可能同时含有更早的引用/残留跳，故以最后一跳判定本批次的传播方式。）
  const classifyChains = (set) => {
    const direct = [], reference = [], residueChains = [];
    for (const chain of set) {
      const tailRef = chain.lastIndexOf(' → 批次引用:');
      const tailRes = chain.lastIndexOf(' → 设备残留:');
      if (tailRes > tailRef) residueChains.push(chain);
      else if (tailRef >= 0) reference.push(chain);
      else direct.push(chain);
    }
    return {
      direct,
      reference,
      residue: residueChains,
      routes: {
        direct: direct.length > 0,
        batch_reference: reference.length > 0,
        equipment_residue: residueChains.length > 0
      },
      count: set.size
    };
  };

  const buildBatch = (bid, state, classification) => {
    const b = batches.get(bid);
    const ev = eventByBatch.get(bid);
    const eq = ev ? equipment.get(ev.equipment_id) : null;
    const confirmedList = [...state.confirmed.chains];
    const unresolvedList = [...state.unresolved.chains];
    if (state.confirmed.truncated) confirmedList.push(TRUNC_MARK);
    if (state.unresolved.truncated) unresolvedList.push(TRUNC_MARK);
    const ships = (shipmentRowsByBatch.get(bid) || []).map(formatShipmentBrief);
    return {
      batch_id: bid,
      batch_code: b ? b.code : `#${bid}`,
      classification, // CONFIRMED / UNRESOLVED
      produced_at: state.eventTime || (ev ? ev.event_time : null),
      equipment_id: ev ? ev.equipment_id : state.equipment_id || null,
      equipment_code: eq ? eq.code : null,
      evidence: {
        confirmed: {
          chain_count: state.confirmed.chains.size,
          truncated: state.confirmed.truncated,
          chains: confirmedList.filter(Boolean),
          ...classifyChains(state.confirmed.chains)
        },
        unresolved: {
          chain_count: state.unresolved.chains.size,
          truncated: state.unresolved.truncated,
          chains: unresolvedList.filter(Boolean),
          ...classifyChains(state.unresolved.chains)
        }
      },
      shipments: ships,
      shipment_count: ships.length
    };
  };

  const confirmedBatches = [];
  const unresolvedBatches = [];
  for (const [bid, state] of batchState.entries()) {
    if (state.confirmed.chains.size > 0) {
      confirmedBatches.push(buildBatch(bid, state, 'CONFIRMED'));
    } else if (state.unresolved.chains.size > 0) {
      unresolvedBatches.push(buildBatch(bid, state, 'UNRESOLVED'));
    }
  }
  const byTime = (x, y) =>
    String(x.produced_at || '').localeCompare(String(y.produced_at || '')) ||
    x.batch_code.localeCompare(y.batch_code, 'zh') || x.batch_id - y.batch_id;
  confirmedBatches.sort(byTime);
  unresolvedBatches.sort(byTime);

  // ---------- 设备当前残留（帮助质检判断批号可能仍滞留的设备） ----------
  const equipmentResidue = [];
  for (const qid of equipment.keys()) {
    const r = residue.get(qid);
    const has = r.confirmed.chains.size > 0 || r.unresolved.chains.size > 0;
    const q = equipment.get(qid);
    const lastClean = lastCleanAt.get(qid) || null;
    if (!has) {
      // 仅列出最近一次清洗发生在“可能相关加工”之后/无残留的设备没有信息量，这里不列空设备，
      // 但清洗截断点在批次证据链中已经体现；保留全部设备为空会稀释结果，故跳过。
      continue;
    }
    const cList = [...r.confirmed.chains];
    const uList = [...r.unresolved.chains];
    if (r.confirmed.truncated) cList.push(TRUNC_MARK);
    if (r.unresolved.truncated && !uList.includes(TRUNC_MARK)) uList.push(TRUNC_MARK);
    equipmentResidue.push({
      equipment_id: qid,
      equipment_code: q.code,
      equipment_name: q.name,
      last_cleaned_at: lastClean,
      // 最后一次已核实清洗后仍有本批号/未知批号残留；下一次加工会继续并入。
      confirmed_chains: cList.filter(Boolean),
      unresolved_chains: uList.filter(Boolean)
    });
  }
  equipmentResidue.sort((a, b) => a.equipment_code.localeCompare(b.equipment_code, 'zh'));

  const confirmedShipments = confirmedBatches.flatMap((b) =>
    b.shipments.map((s) => ({ ...s, batch_id: b.batch_id, batch_code: b.batch_code })));
  const unresolvedShipments = unresolvedBatches.flatMap((b) =>
    b.shipments.map((s) => ({ ...s, batch_id: b.batch_id, batch_code: b.batch_code })));

  return {
    query: {
      mode: mode === 'LOT' ? 'LOT' : 'UNKNOWN_LOT',
      material: { id: material.id, code: material.code, name: material.name },
      lot: lot ? {
        id: lot.id,
        lot_code: lot.lot_code,
        supplier: lot.supplier || '',
        status: lot.status,
        flagged: lot.status === 'FLAGGED',
        flagged_reason: lot.flagged_reason || ''
      } : null,
      path_limit: pathLimit
    },
    generated_at: new Date().toISOString(),
    summary: {
      confirmed_batch_count: confirmedBatches.length,
      unresolved_batch_count: unresolvedBatches.length,
      affected_batch_count: confirmedBatches.length + unresolvedBatches.length,
      confirmed_shipment_count: confirmedShipments.length,
      unresolved_shipment_count: unresolvedShipments.length
    },
    confirmed_batches: confirmedBatches,
    unresolved_batches: unresolvedBatches,
    equipment_residue: equipmentResidue,
    shipments: {
      confirmed: confirmedShipments,
      unresolved: unresolvedShipments
    },
    notice: '本追溯结果仅供质检查询：不会自动改变批次放行、标签卷、出货单与质量处置结论；' +
            '“无法排除”不等同于安全，需线下核实批号后再作处置。'
  };
}

module.exports = { traceMaterial, TraceError, TRUNC_MARK };
