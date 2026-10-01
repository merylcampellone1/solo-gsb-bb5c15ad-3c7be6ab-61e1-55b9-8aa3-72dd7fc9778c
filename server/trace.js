'use strict';
// 供应批号追溯（只读查询，不改变任何放行 / 标签卷 / 出货 / 处置结论）。
//
// 查询“指定原料 M 的指定供应批号 L”时，沿当前最新合法时间线逐时回放，
// 通过三条渠道传播“可能含有该批号原料”的标记：
//   1) 直接投料：加工事件直接投入 M；supplier_lot=L → 确定命中（CONFIRMED）；
//      supplier_lot 为空（批号未知，含仅传 material_ids 的旧写入）→ 无法排除（POSSIBLE）。
//   2) 前序批次引用：加工引用了此前已产出批次，标记随引用并入（CONFIRMED 优先于 POSSIBLE）。
//   3) 同设备未清洗残留：设备自最后一次已核实清洗（CLEAN）之后残留的标记，
//      逐小时传递给后续每次加工；已核实清洗截断残留。
//
// 状态优先级：只要任一渠道给出 CONFIRMED，该批次即为 CONFIRMED（批号未知不降级）；
// 既无确定来源、仅有“批号未知的 M”或上游 POSSIBLE 时为 POSSIBLE。
// 事件更正/删除后按最新合法时间线重放（追溯不缓存派生结果），结论随之更新。
//
// 注意：受影响对象集合（命中批次、关联出货单）不漏报；仅“路径展示”可限量（max_paths）。

const DEFAULT_MAX_PATHS = 20;
const HARD_MAX_PATHS = 500;

class TraceError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
    // 批号不存在/原料不存在明确 404；批号与原料不匹配/参数问题 400。
    this.status = status || 400;
    this.details = details || [];
  }
}

// ---------- 查询参数解析 ----------
function parseQuery(q) {
  q = q || {};
  let material_id = null;
  if (q.material_id !== undefined && String(q.material_id).trim() !== '') {
    material_id = parseInt(q.material_id, 10);
    if (!Number.isInteger(material_id)) {
      throw new TraceError('INVALID_REQUEST', 'material_id 不合法');
    }
  }
  const material_code = q.material_code !== undefined
    ? String(q.material_code).trim() : '';
  if (material_id == null && !material_code) {
    throw new TraceError('INVALID_REQUEST', '请指定原料：material_id 或 material_code 至少提供一个');
  }
  const supplier_lot = String(q.supplier_lot == null ? '' : q.supplier_lot).trim();
  if (!supplier_lot) {
    throw new TraceError('INVALID_REQUEST', '请指定供应批号 supplier_lot');
  }
  let max_paths = DEFAULT_MAX_PATHS;
  if (q.max_paths !== undefined && String(q.max_paths).trim() !== '') {
    max_paths = parseInt(q.max_paths, 10);
    if (!Number.isInteger(max_paths) || max_paths < 1 || max_paths > HARD_MAX_PATHS) {
      throw new TraceError('INVALID_REQUEST',
        `max_paths 必须是 1~${HARD_MAX_PATHS} 之间的整数（默认 ${DEFAULT_MAX_PATHS}，仅限制路径展示条数）`);
    }
  }
  return { material_id, material_code, supplier_lot, max_paths };
}

function resolveMaterial(db, params) {
  let material = null;
  if (material_id_supplied(params)) {
    material = db.prepare('SELECT id, code, name FROM materials WHERE id = ?')
      .get(params.material_id);
  }
  if (!material && params.material_code) {
    material = db.prepare('SELECT id, code, name FROM materials WHERE code = ?')
      .get(params.material_code);
  }
  if (!material) {
    throw new TraceError(
      'MATERIAL_NOT_FOUND',
      '指定的原料不存在，请先在“原料与设备”中登记该原料',
      404
    );
  }
  return material;
}
function material_id_supplied(p) { return p.material_id != null; }

// 校验批号：目标原料名下不存在该批号时——
//   批号在其它原料名下出现过 → 400 SUPPLIER_LOT_MISMATCH（与原料不匹配，明确拒绝）；
//   全库从未出现 → 404 SUPPLIER_LOT_NOT_FOUND（批号不存在，明确拒绝）。
function assertLotExistsForMaterial(db, material, lot) {
  const own = db.prepare(
    `SELECT COUNT(*) AS c FROM process_inputs
      WHERE material_id = ? AND supplier_lot IS NOT NULL AND supplier_lot = ?`
  ).get(material.id, lot).c;
  if (own > 0) return;

  const others = db.prepare(
    `SELECT DISTINCT m.id, m.code, m.name
       FROM process_inputs pi JOIN materials m ON m.id = pi.material_id
      WHERE pi.supplier_lot = ? AND pi.material_id != ?
      ORDER BY m.code`
  ).all(lot, material.id);
  if (others.length) {
    throw new TraceError(
      'SUPPLIER_LOT_MISMATCH',
      `供应批号“${lot}”与原料 ${material.name}(${material.code}) 不匹配：` +
      `该批号登记在其它原料名下（${others.map((m) => `${m.name}(${m.code})`).join('、')}），拒绝追溯`,
      400,
      others.map((m) => ({ material_id: m.id, material_code: m.code, material_name: m.name }))
    );
  }
  throw new TraceError(
    'SUPPLIER_LOT_NOT_FOUND',
    `供应批号“${lot}”不存在：任何加工事件中都没有原料 ${material.name}(${material.code}) ` +
    '（或其它原料）使用该批号的投料记录，拒绝追溯',
    404
  );
}

// ---------- 逐时回放，构造传播图 ----------
// 每个（涉及的）批次记录：
//   status: 'CONFIRMED' | 'POSSIBLE'
//   direct: [{ lot: string|null }]                      本批直接投入的目标原料（批号/未知）
//   refEdges:  Map<refBatchId, edge>                    前序批次引用渠道
//   residueEdges: Map<carrierBatchId, edge>             同设备未清洗残留渠道
// 设备 residueCarriers: Map<equipmentId, Set<batchId>>  当前残留在册的“载体批次”
//   （已核实清洗清空；每次加工后并入本次产出可追溯到的载体）。
function replay(db, materialId, lot) {
  const materials = new Map(
    db.prepare('SELECT id, code, name FROM materials').all().map((m) => [m.id, m])
  );
  const equipment = new Map(
    db.prepare('SELECT id, code, name FROM equipment').all().map((q) => [q.id, q])
  );
  const batches = new Map(
    db.prepare('SELECT id, code FROM batches').all().map((b) => [b.id, b])
  );
  const events = db.prepare(
    `SELECT id, event_time, type, equipment_id, batch_id
       FROM events ORDER BY event_time, id`
  ).all();
  const inputsByEvent = new Map();
  db.prepare('SELECT event_id, material_id, batch_id, supplier_lot FROM process_inputs')
    .all()
    .forEach((r) => {
      if (!inputsByEvent.has(r.event_id)) inputsByEvent.set(r.event_id, []);
      inputsByEvent.get(r.event_id).push(r);
    });

  const info = new Map(); // batchId -> 批次传播信息
  const residueCarriers = new Map(); // equipmentId -> Set<batchId>
  for (const qid of equipment.keys()) residueCarriers.set(qid, new Set());

  const ensure = (batchId) => {
    if (!info.has(batchId)) {
      info.set(batchId, {
        batch_id: batchId,
        status: null,
        direct: [],
        refEdges: new Map(),
        residueEdges: new Map()
      });
    }
    return info.get(batchId);
  };

  for (const ev of events) {
    if (ev.type === 'CLEAN') {
      residueCarriers.set(ev.equipment_id, new Set()); // 已核实清洗截断设备残留
      continue;
    }
    const inputs = inputsByEvent.get(ev.id) || [];

    // ---- 渠道 1：直接投料（仅目标原料）----
    let directConfirmed = false;
    let directUnknown = false;
    const direct = [];
    // ---- 渠道 2：前序批次引用 ----
    const incomingRefs = []; // { batchId, status }
    for (const inp of inputs) {
      if (inp.material_id === materialId) {
        const unknown = inp.supplier_lot == null || String(inp.supplier_lot).trim() === '';
        if (!unknown && inp.supplier_lot === lot) directConfirmed = true;
        if (unknown) directUnknown = true;
        direct.push({ lot: unknown ? null : String(inp.supplier_lot) });
      } else if (inp.batch_id != null) {
        const st = info.has(inp.batch_id) ? info.get(inp.batch_id).status : null;
        if (st) incomingRefs.push({ batchId: inp.batch_id, status: st });
      }
    }

    // ---- 渠道 3：同设备未清洗残留（加工开始时设备残留在册载体）----
    const eqCode = (equipment.get(ev.equipment_id) || {}).code || `#${ev.equipment_id}`;
    const carried = residueCarriers.get(ev.equipment_id) || new Set();
    const incomingResidue = [...carried]
      .map((cid) => ({ batchId: cid, status: info.has(cid) ? info.get(cid).status : null }))
      .filter((x) => x.status);

    // ---- 汇总状态（CONFIRMED 优先；批号未知不降级确定命中）----
    let status = null;
    if (directConfirmed ||
        incomingRefs.some((x) => x.status === 'CONFIRMED') ||
        incomingResidue.some((x) => x.status === 'CONFIRMED')) {
      status = 'CONFIRMED';
    } else if (directUnknown || incomingRefs.length || incomingResidue.length) {
      status = 'POSSIBLE';
    }

    if (status) {
      const node = ensure(ev.batch_id);
      node.status = status;
      node.direct = direct;
      for (const e of incomingRefs) {
        if (!node.refEdges.has(e.batchId)) node.refEdges.set(e.batchId, { via: 'REF' });
      }
      for (const e of incomingResidue) {
        if (!node.residueEdges.has(e.batchId)) {
          node.residueEdges.set(e.batchId, { via: 'RESIDUE', equipment_code: eqCode });
        }
      }
    }

    // ---- 更新设备残留载体：本次产出携带的标记在未清洗期间继续残留 ----
    // 载体 = 原有载体（原样保留，可追溯残留自哪次加工带入）∪ 本批 ∪ 本批引用闭包中的标记批次。
    if (status) {
      const next = new Set(carried);
      for (const b of freshClosure(info, ev.batch_id)) next.add(b);
      residueCarriers.set(ev.equipment_id, next);
    }
  }

  // 补充展示信息
  const eventByBatch = new Map();
  for (const ev of events) {
    if (ev.type === 'PROCESS' && ev.batch_id != null) eventByBatch.set(ev.batch_id, ev);
  }
  for (const [batchId, node] of info) {
    const ev = eventByBatch.get(batchId);
    const b = batches.get(batchId) || { code: `#${batchId}` };
    const q = ev ? equipment.get(ev.equipment_id) : null;
    node.code = b.code;
    node.produced_at = ev ? ev.event_time : null;
    node.event_id = ev ? ev.id : null;
    node.equipment_id = ev ? ev.equipment_id : null;
    node.equipment_code = q ? q.code : null;
    node.equipment_name = q ? q.name : null;
  }

  return { info, materials, equipment };
}

// 经“前序批次引用”可新鲜追溯到的标记批次闭包（含自身）。
// 引用关系经校验无环（validateAll 拦截未来引用/环），回放按时间序故 seen 集合即可终止。
function freshClosure(info, batchId, seen) {
  seen = seen || new Set();
  if (seen.has(batchId)) return seen;
  const node = info.get(batchId);
  if (!node || !node.status) return seen;
  seen.add(batchId);
  for (const refId of node.refEdges.keys()) freshClosure(info, refId, seen);
  return seen;
}

// ---------- 路径展示（可限量；不影响受影响对象集合的完整性） ----------
// 一条路径 = 种子批次 + 一串“带渠道的边”（REF=前序批次引用 / RESIDUE=同设备未清洗残留）。
// 同一对批次间可能同时存在引用与残留两条渠道，分别枚举为不同路径。
function buildPaths(info, batchId, maxPaths) {
  const target = info.get(batchId);
  if (!target) return { paths: [], truncated: false };

  const routes = []; // 每条：[{batchId, edge:{via,equipment_code?}|null(种子起点)}]
  let truncated = false;

  const predsOf = (id) => {
    const n = info.get(id);
    const out = [];
    for (const [pid, edge] of n.residueEdges) {
      if (info.has(pid)) out.push({ pid, edge });
    }
    for (const [pid, edge] of n.refEdges) {
      if (info.has(pid)) out.push({ pid, edge });
    }
    return out;
  };

  // 倒序 DFS 枚举至“直接投料种子”，达到 max_paths 即停（仅展示限量）。
  const steps = []; // 倒序：{to, edge}，edge 是进入 to 所经渠道（站在当前节点视角的前驱边）
  const dfs = (id) => {
    if (routes.length >= maxPaths) { truncated = true; return; }
    const preds = predsOf(id);
    if (!preds.length) {
      // 到达种子：steps 当前记录的是 target→...→root 的倒序边，整理为正序节点链。
      const chain = [{ batchId: id, edge: null }];
      for (let i = steps.length - 1; i >= 0; i--) chain.push({ batchId: steps[i].to, edge: steps[i].edge });
      routes.push(chain);
      return;
    }
    for (const p of preds) {
      if (routes.length >= maxPaths) { truncated = true; break; }
      if (steps.some((s) => s.to === p.pid)) continue; // 防御：不环走
      steps.push({ to: id, edge: p.edge });
      dfs(p.pid);
      steps.pop();
    }
  };
  dfs(batchId);

  // 渠道感知去重 + 按长度/编码稳定排序，再正序格式化为中文路径链。
  const seenKey = new Set();
  const chains = [];
  for (const chain of routes) {
    const key = chain.map((n, i) =>
      `${n.batchId}:${i === 0 ? 'SEED' : `${n.edge.via}${n.edge.equipment_code || ''}`}`).join('>');
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    chains.push(chain);
  }
  chains.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    const ka = a.map((n) => `${n.batchId}/${n.edge ? n.edge.via : 'S'}`).join('>');
    const kb = b.map((n) => `${n.batchId}/${n.edge ? n.edge.via : 'S'}`).join('>');
    return ka.localeCompare(kb);
  });

  const fmt = (t) => t ? t.replace('T', ' ') : '时间未知';
  const rendered = chains.map((chain) => {
    const root = info.get(chain[0].batchId);
    const rootLots = root.direct.length
      ? root.direct.map((d) => d.lot ? `批号 ${d.lot}` : '批号未知').join('、')
      : '批号未知';
    let text = `直接投料[${rootLots}] → 批次 ${root.code}（${fmt(root.produced_at)}）`;
    for (let i = 1; i < chain.length; i++) {
      const cur = info.get(chain[i].batchId);
      const edge = chain[i].edge;
      if (edge.via === 'RESIDUE') {
        text += ` → 同设备${edge.equipment_code || ''}未清洗残留 → 批次 ${cur.code}（${fmt(cur.produced_at)}）`;
      } else {
        text += ` → 前序批次引用 → 批次 ${cur.code}（${fmt(cur.produced_at)}）`;
      }
    }
    return {
      root_status: root.status,
      root_batch_code: root.code,
      root_lots_unknown: root.direct.length ? root.direct.every((d) => !d.lot) : true,
      chain: chain.map((n) => {
        const x = info.get(n.batchId);
        return {
          batch_id: x.batch_id, batch_code: x.code, produced_at: x.produced_at,
          via: n.edge ? n.edge.via : null,
          equipment_code: n.edge ? (n.edge.equipment_code || null) : null
        };
      }),
      path: text
    };
  });
  return { paths: rendered, truncated };
}

// ---------- 出货单关联 ----------
function shipmentsOfBatch(db, batchId) {
  const rows = db.prepare(
    `SELECT s.*,
            (SELECT d.decision FROM shipment_dispositions d
              WHERE d.shipment_id = s.id ORDER BY d.id DESC LIMIT 1) AS last_decision,
            (SELECT d.life_status FROM shipment_dispositions d
              WHERE d.shipment_id = s.id ORDER BY d.id DESC LIMIT 1) AS last_life_status
       FROM shipments s WHERE s.batch_id = ? ORDER BY s.id`
  ).all(batchId);
  return rows.map((s) => ({
    shipment_id: s.id,
    shipment_code: s.shipment_code,
    status: s.status,
    pending_review: s.status === 'PENDING_REVIEW',
    review_reason: s.review_reason || '',
    ship_qty: s.ship_qty,
    shipped_at: s.shipped_at,
    shipped_by: s.shipped_by,
    current_decision: s.last_decision || null,
    current_decision_text: s.last_decision
      ? (s.last_decision === 'CONTINUE' ? '准予继续流转' : '召回')
      : null,
    current_disposition_life_status: s.last_life_status || null
  }));
}

// ---------- 对外主入口 ----------
function trace(db, query) {
  const params = parseQuery(query);
  const material = resolveMaterial(db, params);
  assertLotExistsForMaterial(db, material, params.supplier_lot);

  const { info } = replay(db, material.id, params.supplier_lot);

  const confirmed = [];
  const possible = [];
  const affectedShipments = new Map(); // shipment_id -> { ..., matched_via:Set }

  const sortNode = (x, y) =>
    String(x.produced_at || '').localeCompare(String(y.produced_at || '')) ||
    (x.code || '').localeCompare(y.code || '', 'zh') || x.batch_id - y.batch_id;
  const markedNodes = [...info.values()].filter((n) => n.status);
  markedNodes.sort(sortNode);

  for (const node of markedNodes) {
    const batchId = node.batch_id;
    const { paths, truncated } = buildPaths(info, batchId, params.max_paths);
    const directLots = node.direct.map((d) => d.lot);
    const basis = {
      direct_inputs: {
        used_target_lot: directLots.includes(params.supplier_lot),
        target_lot: params.supplier_lot,
        target_lot_input_count: directLots.filter((l) => l === params.supplier_lot).length,
        other_known_lots: [...new Set(directLots.filter((l) => l && l !== params.supplier_lot))],
        unknown_lot_input_count: directLots.filter((l) => !l).length
      },
      via_refs: [...node.refEdges.keys()].map((pid) => {
        const p = info.get(pid);
        return {
          batch_id: pid, batch_code: p.code, status: p.status, produced_at: p.produced_at
        };
      }).sort((a, b) =>
        String(a.produced_at || '').localeCompare(String(b.produced_at || '')) || a.batch_id - b.batch_id),
      via_residue: [...node.residueEdges.entries()].map(([pid, edge]) => {
        const p = info.get(pid);
        return {
          batch_id: pid, batch_code: p.code, status: p.status, produced_at: p.produced_at,
          equipment_code: edge.equipment_code
        };
      }).sort((a, b) =>
        String(a.produced_at || '').localeCompare(String(b.produced_at || '')) || a.batch_id - b.batch_id)
    };

    const shipments = shipmentsOfBatch(db, batchId);
    for (const s of shipments) {
      if (!affectedShipments.has(s.shipment_id)) {
        affectedShipments.set(s.shipment_id, { ...s, matched_via: new Set() });
      }
      affectedShipments.get(s.shipment_id).matched_via.add(node.code);
    }

    const entry = {
      batch_id: batchId,
      batch_code: node.code,
      produced_at: node.produced_at,
      event_id: node.event_id,
      equipment_id: node.equipment_id,
      equipment_code: node.equipment_code,
      equipment_name: node.equipment_name,
      status: node.status,
      basis,
      path_count_total: countAllPaths(info, batchId),
      paths_shown: paths.length,
      paths_truncated: truncated,
      paths,
      shipments
    };
    (node.status === 'CONFIRMED' ? confirmed : possible).push(entry);
  }

  const affected_shipments = [...affectedShipments.values()]
    .map((s) => ({ ...s, matched_via: [...s.matched_via] }))
    .sort((a, b) =>
      String(a.shipped_at || '').localeCompare(String(b.shipped_at || '')) || a.shipment_id - b.shipment_id);

  return {
    query: {
      material_id: material.id,
      material_code: material.code,
      material_name: material.name,
      supplier_lot: params.supplier_lot,
      max_paths: params.max_paths
    },
    summary: {
      confirmed_batch_count: confirmed.length,
      possible_batch_count: possible.length,
      affected_shipment_count: affected_shipments.length
    },
    confirmed_batches: confirmed,
    possible_batches: possible,
    affected_shipments,
    note: '追溯结果仅供查询：不自动改变批次放行、标签卷、出货单与质量处置结论。' +
      '“批号未知”批次无法排除该供应批号，不得据此列为安全。'
  };
}

// 完整路径数（不受 max_paths 限制；用于提示“展示了多少 / 共多少”）。
function countAllPaths(info, batchId) {
  let n = 0;
  const seen = new Set();
  const count = (id) => {
    if (n >= HARD_MAX_PATHS) return;
    const node = info.get(id);
    const preds = [...node.residueEdges.keys(), ...node.refEdges.keys()]
      .filter((pid) => info.has(pid) && !seen.has(pid));
    if (!preds.length) { n += 1; return; }
    seen.add(id);
    for (const pid of preds) count(pid);
    seen.delete(id);
  };
  count(batchId);
  return n;
}

// ---------- 原料名下已登记批号清单（供前端下拉 / API 探查） ----------
function listLots(db, idOrCode) {
  const key = String(idOrCode || '').trim();
  let material = null;
  if (/^\d+$/.test(key)) {
    material = db.prepare('SELECT id, code, name FROM materials WHERE id = ?').get(parseInt(key, 10));
  }
  if (!material) {
    material = db.prepare('SELECT id, code, name FROM materials WHERE code = ?').get(key);
  }
  if (!material) {
    throw new TraceError('MATERIAL_NOT_FOUND', '指定的原料不存在', 404);
  }
  const rows = db.prepare(
    `SELECT supplier_lot,
            COUNT(*) AS input_count,
            MIN(e.event_time) AS first_used_at,
            MAX(e.event_time) AS last_used_at
       FROM process_inputs pi JOIN events e ON e.id = pi.event_id
      WHERE pi.material_id = ? AND pi.supplier_lot IS NOT NULL AND TRIM(pi.supplier_lot) <> ''
      GROUP BY pi.supplier_lot
      ORDER BY MIN(e.event_time), pi.supplier_lot`
  ).all(material.id);
  const unknownCount = db.prepare(
    `SELECT COUNT(*) AS c FROM process_inputs WHERE material_id = ?
      AND (supplier_lot IS NULL OR TRIM(supplier_lot) = '')`
  ).get(material.id).c;
  return {
    material: { id: material.id, code: material.code, name: material.name },
    lots: rows.map((r) => ({
      supplier_lot: r.supplier_lot,
      input_count: r.input_count,
      first_used_at: r.first_used_at,
      last_used_at: r.last_used_at
    })),
    unknown_lot_input_count: unknownCount
  };
}

module.exports = { TraceError, trace, listLots, replay, DEFAULT_MAX_PATHS };
