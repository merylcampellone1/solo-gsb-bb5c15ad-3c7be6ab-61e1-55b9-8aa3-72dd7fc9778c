'use strict';
// 换线整组预演 / 确认应用。
//
//   POST /api/replan/preview  ：提交一组“既有事件更正 + 拟插入的清洗事件”，
//                                在内存影子库上应用 -> 全量校验 -> 全量重算，
//                                返回应用前后每批过敏原、设备残留、将失效放行的差异。
//                                不触碰正式事件、推导结果与放行状态。
//   POST /api/replan/apply    ：携带预演返回的 version 与完全相同的 changes，
//                                在一次事务中重新校验指纹、重新校验并重算后落库。
//
// 版本（业务版本）采用无状态签名令牌：载荷为「正式状态指纹 + 变更内容哈希 + 时间戳」，
// 用进程密钥做 HMAC。预演后任何会改变推导输入/结果的正式写入
// （事件、原料过敏原、放行等）都会改变指纹，应用时指纹对不上即拒绝且原状态不变。

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { initSchema } = require('./db');
const { validateAll } = require('./validation');
const { recompute } = require('./recompute');

const PREVIEW_TTL_MS = 30 * 60 * 1000; // 预演版本有效期 30 分钟
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 进程级随机密钥：重启后旧预演令牌自然失效（返回 VERSION_EXPIRED/INVALID）。
const SIGN_SECRET = crypto.randomBytes(32);

class ReplanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReplanError';
    this.code = code;
    this.details = details || [];
  }
}

// ---------- 变更内容 ----------
// 规范化后的单条变更：
//   { op:'update', event_id, type, event_time, equipment_id, note,
//     batch_code?, material_ids?, ref_batch_ids? }
//   { op:'insert_clean', client_key?, event_time, equipment_id, note }
function normalizeChanges(rawChanges) {
  if (!Array.isArray(rawChanges)) {
    return [new ReplanError('INVALID_REQUEST', 'changes 必须是数组')];
  }
  if (rawChanges.length === 0) {
    return [new ReplanError('INVALID_REQUEST', '至少提交一条变更')];
  }

  const errors = [];
  const changes = [];
  const seenEvent = new Set();
  const seenInsertKey = new Set();

  rawChanges.forEach((raw, idx) => {
    const where = `changes[${idx}]`;
    const ch = raw && typeof raw === 'object' ? raw : null;
    if (!ch) { errors.push(`${where}：变更项必须是对象`); return; }

    let op = String(ch.op || '').toLowerCase();
    if (op === 'insert') {
      op = ch.type && String(ch.type).toUpperCase() === 'CLEAN' ? 'insert_clean' : 'insert_process';
    }
    if (op === 'insert_process') {
      errors.push(`${where}：本轮预演仅支持插入清洗事件（op:"insert_clean"），不支持插入加工事件`);
      return;
    }
    if (op !== 'update' && op !== 'insert_clean') {
      errors.push(`${where}：op 仅支持 "update"（更正既有事件）或 "insert_clean"（插入清洗事件）`);
      return;
    }

    // ---- 更正既有事件 ----
    if (op === 'update') {
      const event_id = parseInt(ch.event_id, 10);
      if (!Number.isInteger(event_id)) {
        errors.push(`${where}：更正缺少已知的 event_id`);
        return;
      }
      if (seenEvent.has(event_id)) {
        errors.push(`${where}：事件 #${event_id} 在本次提交中被重复更正`);
        return;
      }
      seenEvent.add(event_id);

      const type = ch.type ? String(ch.type).toUpperCase() : '';
      if (type && type !== 'PROCESS' && type !== 'CLEAN') {
        errors.push(`${where}：事件类型必须为 PROCESS 或 CLEAN`);
        return;
      }
      const event_time = String(ch.event_time || '').trim();
      if (!event_time) {
        errors.push(`${where}：缺少事件时间 event_time`);
        return;
      }
      if (!TIME_RE.test(event_time)) {
        errors.push(`${where}：事件时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-09-30T08:00`);
        return;
      }
      const equipment_id = parseInt(ch.equipment_id, 10);
      if (!Number.isInteger(equipment_id)) {
        errors.push(`${where}：缺少设备 equipment_id`);
        return;
      }
      const note = String(ch.note || '').trim();
      const norm = { op, event_id, type, event_time, equipment_id, note };
      if (type === 'PROCESS') {
        const batch_code = String(ch.batch_code || '').trim();
        if (!batch_code) {
          errors.push(`${where}：加工事件更正必须携带产出批次编码 batch_code`);
          return;
        }
        norm.batch_code = batch_code;
        norm.material_ids = idList(ch.material_ids);
        norm.ref_batch_ids = idList(ch.ref_batch_ids);
        // 可选：material_inputs 带批号的全量覆盖输入 {material_id, lot_id?|lot_code?}
        if (ch.material_inputs !== undefined && ch.material_inputs !== null) {
          if (!Array.isArray(ch.material_inputs)) {
            errors.push(`${where}：material_inputs 必须是数组`);
            return;
          }
          const parsed = [];
          let bad = false;
          ch.material_inputs.forEach((inp, j) => {
            if (bad) return;
            const w = `${where}.material_inputs[${j}]`;
            if (!inp || typeof inp !== 'object') {
              errors.push(`${w} 必须是 {material_id, lot_id?|lot_code?} 对象`);
              bad = true; return;
            }
            const mid = parseInt(inp.material_id, 10);
            if (!Number.isInteger(mid)) {
              errors.push(`${w} 缺少合法的 material_id`);
              bad = true; return;
            }
            const hasLotId = inp.lot_id !== undefined && inp.lot_id !== null && inp.lot_id !== '';
            const hasLotCode = inp.lot_code !== undefined && inp.lot_code !== null && inp.lot_code !== '';
            if (hasLotId && hasLotCode) {
              errors.push(`${w}：lot_id 与 lot_code 只能提供其一`);
              bad = true; return;
            }
            let lotIdRaw = null;
            let lotCodeRaw = null;
            if (hasLotId) {
              lotIdRaw = parseInt(inp.lot_id, 10);
              if (!Number.isInteger(lotIdRaw)) {
                errors.push(`${w}：lot_id 不合法`);
                bad = true; return;
              }
            } else if (hasLotCode) {
              lotCodeRaw = String(inp.lot_code).trim();
              if (!lotCodeRaw) {
                errors.push(`${w}：lot_code 不能为空`);
                bad = true; return;
              }
            }
            parsed.push({ material_id: mid, lot_id: lotIdRaw, lot_code: lotCodeRaw });
          });
          if (bad) return;
          norm.material_inputs = parsed;
          // 同时携带 material_ids 时原料集合必须一致
          if (norm.material_ids.length) {
            const a = [...new Set(parsed.map((x) => x.material_id))].sort((x, y) => x - y);
            const b = [...new Set(norm.material_ids)].sort((x, y) => x - y);
            if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
              errors.push(`${where}：material_inputs 与 material_ids 涉及的原料集合不一致`);
              return;
            }
          } else {
            norm.material_ids = [...new Set(parsed.map((x) => x.material_id))];
          }
        }
      }
      changes.push(norm);
      return;
    }

    // ---- 插入清洗事件 ----
    const event_time = String(ch.event_time || '').trim();
    if (!event_time) {
      errors.push(`${where}：拟插入的清洗事件缺少时间 event_time（必须明确指定）`);
      return;
    }
    if (!TIME_RE.test(event_time)) {
      errors.push(`${where}：清洗事件时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-09-30T12:30`);
      return;
    }
    const equipment_id = parseInt(ch.equipment_id, 10);
    if (!Number.isInteger(equipment_id)) {
      errors.push(`${where}：缺少设备 equipment_id`);
      return;
    }
    const client_key = ch.client_key != null ? String(ch.client_key) : null;
    if (client_key !== null) {
      if (seenInsertKey.has(client_key)) {
        errors.push(`${where}：插入清洗事件的 client_key "${client_key}" 重复`);
        return;
      }
      seenInsertKey.add(client_key);
    }
    changes.push({
      op: 'insert_clean',
      client_key,
      event_time,
      equipment_id,
      note: String(ch.note || '').trim()
    });
  });

  if (errors.length) return [new ReplanError('INVALID_REQUEST', '变更内容校验未通过', errors)];
  return [null, canonicalOrder(changes)];
}

function idList(v) {
  return [...new Set(
    (Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Number.isInteger)
  )];
}

// 规范化排序：与提交顺序无关，保证“相同变更内容”哈希一致。
function canonicalOrder(changes) {
  return changes.slice().sort((a, b) => {
    if (a.op !== b.op) return a.op < b.op ? -1 : 1;
    if (a.op === 'update') return a.event_id - b.event_id;
    const ka = a.client_key || `${a.event_time}|${a.equipment_id}|${a.note}`;
    const kb = b.client_key || `${b.event_time}|${b.equipment_id}|${b.note}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// 对外回显时只暴露客户端原始字段。
function publicChanges(changes) {
  return changes.map((c) => {
    if (c.op === 'update') {
      const out = {
        op: c.op, event_id: c.event_id, type: c.type,
        event_time: c.event_time, equipment_id: c.equipment_id, note: c.note
      };
      if (c.type === 'PROCESS') {
        out.batch_code = c.batch_code;
        out.material_ids = c.material_ids;
        out.ref_batch_ids = c.ref_batch_ids;
        if (c.material_inputs) {
          out.material_inputs = c.material_inputs.map((x) => {
            const o = { material_id: x.material_id };
            // 规范化阶段为 {lot_id?/lot_code?}，解析引用后统一为 material_lot_id
            const lid = x.material_lot_id !== undefined ? x.material_lot_id : x.lot_id;
            if (lid != null) o.lot_id = lid;
            if (x.lot_code != null) o.lot_code = x.lot_code;
            return o;
          });
        }
      }
      return out;
    }
    const out = {
      op: c.op, event_time: c.event_time, equipment_id: c.equipment_id, note: c.note
    };
    if (c.client_key !== null) out.client_key = c.client_key;
    return out;
  });
}

// ---------- 业务版本（无状态签名令牌） ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', SIGN_SECRET).update(payloadB64).digest());
}
function issueVersion(fingerprint, changesHash) {
  const payloadB64 = b64url(JSON.stringify({
    fp: fingerprint, ch: changesHash, ts: Date.now()
  }));
  return { version: `${payloadB64}.${sign(payloadB64)}`, expires_in_ms: PREVIEW_TTL_MS };
}
function parseVersion(version) {
  if (typeof version !== 'string' || !version.includes('.')) {
    throw new ReplanError('VERSION_INVALID', '预演版本格式不正确');
  }
  const dot = version.indexOf('.');
  const payloadB64 = version.slice(0, dot);
  const sig = version.slice(dot + 1);
  const expected = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new ReplanError('VERSION_INVALID', '预演版本签名不合法');
  }
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
  } catch (_) {
    throw new ReplanError('VERSION_INVALID', '预演版本内容不合法');
  }
  if (!payload || typeof payload.fp !== 'string' || typeof payload.ch !== 'string') {
    throw new ReplanError('VERSION_INVALID', '预演版本内容不合法');
  }
  if (Date.now() - payload.ts > PREVIEW_TTL_MS) {
    throw new ReplanError('VERSION_EXPIRED', '预演版本已过期，请重新预演');
  }
  return payload;
}

// 对规范化变更做稳定序列化（含解析出的 batch_id，仅服务端内部使用）。
function changesHash(changes) {
  return crypto.createHash('sha256').update(canonicalString(changes)).digest('hex');
}
function canonicalString(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalString).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalString(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---------- 正式状态指纹 ----------
// 覆盖所有会影响推导结果或放行差异的正式数据；任何相关正式写入都会使指纹变化。
const FINGERPRINT_SQL = [
  'SELECT id, code, name, allergens FROM materials ORDER BY id',
  'SELECT id, material_id, lot_code, supplier, note, status, flagged_reason, created_at FROM material_lots ORDER BY id',
  'SELECT id, code, name FROM equipment ORDER BY id',
  'SELECT id, event_time, type, equipment_id, batch_id, note FROM events ORDER BY id',
  'SELECT id, code FROM batches ORDER BY id',
  'SELECT id, event_id, material_id, batch_id, material_lot_id FROM process_inputs ORDER BY id',
  `SELECT id, batch_id, released_at, released_by, snapshot_allergens, status,
          invalid_reason, created_event_seq FROM releases ORDER BY id`,
  // 出货单/明细不影响推导结果，但会影响“将停用卷/待评估出货单”的预测，故一并纳入指纹：
  // 预演后新增出货等正式写入会使旧版本过期，避免按过期预测确认应用。
  `SELECT id, shipment_code, batch_id, batch_code, ship_qty, allergen_set, status,
          review_reason, shipped_at, shipped_by FROM shipments ORDER BY id`,
  `SELECT id, shipment_id, roll_id, roll_code, release_id, release_at, release_by,
          allergen_set, roll_revision, qty FROM shipment_items ORDER BY id`,
  // 质量处置记录与出货单状态版本同样纳入指纹：预演后登记处置会使旧预演版本过期。
  `SELECT id, shipment_id, decision, decided_by, basis, expected_version, context_hash,
          context_snapshot, status_version, life_status, stale_reason, decided_at
     FROM shipment_dispositions ORDER BY id`,
  `SELECT shipment_id, version FROM shipment_versions ORDER BY shipment_id`
];
function stateFingerprint(db) {
  const h = crypto.createHash('sha256');
  for (const sql of FINGERPRINT_SQL) {
    h.update(sql).update('\0').update(canonicalString(db.prepare(sql).all()));
  }
  return h.digest('hex');
}

// ---------- 快照与差异 ----------
function takeSnapshot(db) {
  const batches = new Map();
  db.prepare(
    `SELECT b.id, b.code, bo.allergens, ev.event_time AS produced_at
       FROM batches b
       LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
       LEFT JOIN events ev ON ev.batch_id = b.id`
  ).all().forEach((b) => batches.set(b.id, {
    id: b.id, code: b.code,
    produced_at: b.produced_at || null,
    allergens: b.allergens ? JSON.parse(b.allergens) : []
  }));

  const residues = new Map();
  db.prepare(
    `SELECT e.id, e.code, COALESCE(r.allergens,'[]') AS allergens, r.last_cleaned_at
       FROM equipment e LEFT JOIN equipment_residue r ON r.equipment_id = e.id`
  ).all().forEach((e) => residues.set(e.id, {
    equipment_id: e.id, equipment_code: e.code,
    allergens: JSON.parse(e.allergens),
    last_cleaned_at: e.last_cleaned_at || null
  }));

  const releases = new Map();
  db.prepare(
    `SELECT r.id, r.batch_id, b.code AS batch_code, r.released_at, r.released_by,
            r.snapshot_allergens, r.status, r.invalid_reason
       FROM releases r JOIN batches b ON b.id = r.batch_id`
  ).all().forEach((r) => releases.set(r.id, {
    id: r.id, batch_id: r.batch_id, batch_code: r.batch_code,
    released_at: r.released_at, released_by: r.released_by,
    snapshot_allergens: JSON.parse(r.snapshot_allergens),
    status: r.status, invalid_reason: r.invalid_reason
  }));

  return { batches, residues, releases };
}

function sortZh(arr) {
  return arr.sort((a, b) => a.localeCompare(b, 'zh'));
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// 差异仅包含发生变化的条目。
function diffSnapshots(before, after) {
  // ---- 批次过敏原 ----
  const batches = [];
  for (const [id, aft] of after.batches) {
    const bef = before.batches.get(id);
    const beforeA = sortZh(bef ? bef.allergens.slice() : []);
    const afterA = sortZh(aft.allergens.slice());
    if (bef && sameSet(beforeA, afterA)) continue;
    batches.push({
      batch_id: id, code: aft.code, produced_at: aft.produced_at,
      before_allergens: beforeA,
      after_allergens: afterA,
      added: sortZh(afterA.filter((a) => !beforeA.includes(a))),
      removed: sortZh(beforeA.filter((a) => !afterA.includes(a)))
    });
  }
  batches.sort((a, b) =>
    String(a.produced_at || '').localeCompare(String(b.produced_at || '')) ||
    a.code.localeCompare(b.code, 'zh'));

  // ---- 设备残留 ----
  const equipment_residue = [];
  for (const [id, aft] of after.residues) {
    const bef = before.residues.get(id);
    const beforeA = sortZh(bef ? bef.allergens.slice() : []);
    const afterA = sortZh(aft.allergens.slice());
    const cleanMoved = bef && bef.last_cleaned_at !== aft.last_cleaned_at;
    if (!cleanMoved && sameSet(beforeA, afterA)) continue;
    equipment_residue.push({
      equipment_id: id, equipment_code: aft.equipment_code,
      before_allergens: beforeA,
      after_allergens: afterA,
      added: sortZh(afterA.filter((a) => !beforeA.includes(a))),
      removed: sortZh(beforeA.filter((a) => !afterA.includes(a))),
      before_last_cleaned_at: bef ? bef.last_cleaned_at : null,
      after_last_cleaned_at: aft.last_cleaned_at
    });
  }
  equipment_residue.sort((a, b) => a.equipment_code.localeCompare(b.equipment_code, 'zh'));

  // ---- 放行：有效 -> 失效（“将失效”），以及状态/原因的其它变化 ----
  const releases = [];
  for (const [id, aft] of after.releases) {
    const bef = before.releases.get(id);
    if (!bef) continue; // 预演不新增/删除放行
    if (bef.status === aft.status && bef.invalid_reason === aft.invalid_reason) continue;
    releases.push({
      release_id: id, batch_id: aft.batch_id, batch_code: aft.batch_code,
      released_at: aft.released_at, released_by: aft.released_by,
      snapshot_allergens: aft.snapshot_allergens,
      before_status: bef.status, after_status: aft.status,
      before_invalid_reason: bef.invalid_reason,
      after_invalid_reason: aft.invalid_reason
    });
  }
  releases.sort((a, b) =>
    a.released_at.localeCompare(b.released_at) || a.release_id - b.release_id);

  return {
    summary: {
      batches_changed: batches.length,
      equipment_residue_changed: equipment_residue.length,
      releases_will_invalidate: releases.filter((r) =>
        r.before_status === 'ACTIVE' && r.after_status === 'INVALIDATED').length,
      releases_changed: releases.length
    },
    batches,
    equipment_residue,
    releases
  };
}

// ---------- 引用解析（设备/原料/批次是否存在、事件是否存在） ----------
function resolveChangeRefs(db, changes) {
  const errors = [];
  const knownEquip = new Set(db.prepare('SELECT id FROM equipment').all().map((e) => e.id));
  const knownMat = new Set(db.prepare('SELECT id FROM materials').all().map((m) => m.id));
  const batchRows = db.prepare('SELECT id, code FROM batches').all();
  const codeToBatch = new Map(batchRows.map((b) => [b.code, b.id]));
  const knownBatch = new Set(batchRows.map((b) => b.id));

  const resolved = changes.map((c) => ({ ...c }));

  for (const c of resolved) {
    const target = c.op === 'update' ? `事件 #${c.event_id} 的更正` : '拟插入的清洗事件';
    if (!knownEquip.has(c.equipment_id)) {
      errors.push(`${target}：设备 #${c.equipment_id} 不存在，请先登记设备`);
    }
    if (c.op !== 'update') continue;

    const ev = db.prepare('SELECT id, type, batch_id FROM events WHERE id = ?').get(c.event_id);
    if (!ev) {
      errors.push(`事件 #${c.event_id} 不存在（未知事件不可更正，请先在正式时间线中创建）`);
      continue;
    }
    if (c.type !== ev.type) {
      errors.push(`事件 #${c.event_id}：事件类型（加工/清洗）不可变更，请删除后新建`);
      continue;
    }
    if (ev.type === 'PROCESS') {
      if (!ev.batch_id) {
        errors.push(`事件 #${c.event_id}：加工事件缺少产出批次（数据异常）`);
        continue;
      }
      c._batch_id = ev.batch_id;
      const ownerId = codeToBatch.get(c.batch_code);
      if (ownerId && ownerId !== ev.batch_id) {
        errors.push(`事件 #${c.event_id}：批次编码 "${c.batch_code}" 已被其它批次占用，批次编码必须唯一`);
      }
      for (const mid of c.material_ids) {
        if (!knownMat.has(mid)) errors.push(`事件 #${c.event_id}：原料 #${mid} 不存在`);
      }
      // 带批号的原料输入：批号必须存在且属于该原料（lot_code 在解析时补成 lot_id）。
      if (Array.isArray(c.material_inputs)) {
        const lotRows = db.prepare('SELECT id, material_id, lot_code FROM material_lots').all();
        const lotById = new Map(lotRows.map((l) => [l.id, l]));
        const lotByCode = new Map(lotRows.map((l) => [`${l.material_id}|${l.lot_code}`, l]));
        c.material_inputs = c.material_inputs.map((inp) => {
          let lotId = null;
          if (inp.lot_id != null) {
            const lot = lotById.get(inp.lot_id);
            if (!lot) {
              errors.push(`事件 #${c.event_id}：供应批号 #${inp.lot_id} 不存在`);
            } else if (lot.material_id !== inp.material_id) {
              errors.push(
                `事件 #${c.event_id}：供应批号 ${lot.lot_code}（#${lot.id}）属于原料 #${lot.material_id}，` +
                `与输入原料 #${inp.material_id} 不匹配`
              );
            } else {
              lotId = lot.id;
            }
          } else if (inp.lot_code != null) {
            const lot = lotByCode.get(`${inp.material_id}|${inp.lot_code}`);
            if (!lot) {
              errors.push(
                `事件 #${c.event_id}：原料 #${inp.material_id} 下不存在供应批号 "${inp.lot_code}"`
              );
            } else {
              lotId = lot.id;
            }
          }
          return { material_id: inp.material_id, material_lot_id: lotId };
        });
      }
      for (const bid of c.ref_batch_ids) {
        if (!knownBatch.has(bid)) {
          errors.push(`事件 #${c.event_id}：引用批次 #${bid} 不存在`);
        }
      }
      if (c.ref_batch_ids.includes(ev.batch_id)) {
        errors.push(`事件 #${c.event_id}：批次不能引用自身`);
      }
    }
  }

  if (errors.length) {
    throw new ReplanError('REPLAN_REJECTED', '整组变更引用的档案不存在', errors);
  }
  return resolved;
}

// ---------- 将变更写入给定库（影子库 或 正式事务） ----------
function applyChangesTo(db, resolved) {
  const insEvent = db.prepare(
    'INSERT INTO events (event_time, type, equipment_id, batch_id, note) VALUES (?,?,?,?,?)'
  );
  const updEvent = db.prepare(
    'UPDATE events SET event_time=?, equipment_id=?, note=? WHERE id=?'
  );
  const updBatchCode = db.prepare('UPDATE batches SET code=? WHERE id=?');
  const delInputs = db.prepare('DELETE FROM process_inputs WHERE event_id=?');
  const insMatInput = db.prepare('INSERT INTO process_inputs (event_id, material_id) VALUES (?,?)');
  const insMatLotInput = db.prepare(
    'INSERT INTO process_inputs (event_id, material_id, material_lot_id) VALUES (?,?,?)'
  );
  const insBatchInput = db.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)');

  // 先更正，再插入，保证自增序列与影子库一致。
  for (const c of resolved) {
    if (c.op !== 'update') continue;
    if (c.type === 'PROCESS') {
      updBatchCode.run(c.batch_code, c._batch_id);
      delInputs.run(c.event_id);
      if (Array.isArray(c.material_inputs)) {
        for (const inp of c.material_inputs) {
          insMatLotInput.run(c.event_id, inp.material_id, inp.material_lot_id);
        }
      } else {
        for (const mid of c.material_ids) insMatInput.run(c.event_id, mid);
      }
      for (const bid of c.ref_batch_ids) insBatchInput.run(c.event_id, bid);
    }
    updEvent.run(c.event_time, c.equipment_id, c.note, c.event_id);
  }
  const inserted = [];
  for (const c of resolved) {
    if (c.op !== 'insert_clean') continue;
    const id = insEvent.run(c.event_time, 'CLEAN', c.equipment_id, null, c.note).lastInsertRowid;
    inserted.push({ client_key: c.client_key, event_id: id });
  }
  return inserted;
}

// ---------- 影子库（预演专用：完整拷贝正式库的内存 SQLite） ----------
function openShadow(sourceDb) {
  const shadow = new Database(':memory:');
  shadow.pragma('foreign_keys = OFF'); // 拷贝期：父表先于子表写入
  initSchema(shadow);
  const copy = (table, columns) => {
    const rows = sourceDb.prepare(`SELECT ${columns} FROM ${table}`).raw().all();
    const stmt = shadow.prepare(
      `INSERT INTO ${table} (${columns}) VALUES (${columns.split(',').map(() => '?').join(',')})`
    );
    const tx = shadow.transaction((rs) => { for (const r of rs) stmt.run(...r); });
    tx(rows);
  };
  copy('materials', 'id,code,name,allergens');
  copy('material_lots', 'id,material_id,lot_code,supplier,note,status,flagged_reason,created_at');
  copy('equipment', 'id,code,name');
  copy('batches', 'id,code');
  copy('events', 'id,event_time,type,equipment_id,batch_id,note');
  copy('process_inputs', 'id,event_id,material_id,batch_id,material_lot_id');
  copy('batch_outputs', 'batch_id,allergens,paths_json');
  copy('equipment_residue', 'equipment_id,allergens,paths_json,last_cleaned_at');
  copy('releases', 'id,batch_id,released_at,released_by,snapshot_allergens,status,invalid_reason,created_event_seq');
  copy('label_rolls', 'id,roll_code,batch_id,release_id,print_qty,applied_qty,void_qty,revision,allergen_set,registered_at,registered_by,status,retired_reason');
  copy('label_roll_usages', 'id,roll_id,used_at,applied_qty,void_qty,expected_revision,used_by');
  copy('shipments', 'id,shipment_code,batch_id,batch_code,ship_qty,allergen_set,status,review_reason,shipped_at,shipped_by,created_at');
  copy('shipment_items', 'id,shipment_id,roll_id,roll_code,release_id,release_at,release_by,allergen_set,roll_revision,qty');
  copy('shipment_dispositions', 'id,shipment_id,decision,decided_by,basis,expected_version,context_hash,context_snapshot,status_version,life_status,stale_reason,decided_at,created_at');
  copy('shipment_versions', 'shipment_id,version');
  shadow.pragma('foreign_keys = ON');
  return shadow;
}

// 在影子库上完整预演；成功返回 { resolved, inserted, snapshotAfter, diff }。
function simulate(db, changes) {
  const resolved = resolveChangeRefs(db, changes);
  const before = takeSnapshot(db);
  const shadow = openShadow(db);
  try {
    const inserted = applyChangesTo(shadow, resolved);

    const errors = validateAll(shadow);
    if (errors.length) {
      throw new ReplanError('REPLAN_REJECTED', '整组变更应用后的时间线校验未通过', errors);
    }
    recompute(shadow);
    const after = takeSnapshot(shadow);
    // 影子库中“正式库原为 ACTIVE、重算后转为 RETIRED”的标签卷（本已停用的不计入“将停用”）
    const activeRealIds = new Set(db.prepare(
      "SELECT id FROM label_rolls WHERE status = 'ACTIVE'"
    ).all().map((r) => r.id));
    const retiredRolls = shadow.prepare(
      `SELECT lr.id, lr.roll_code, b.code AS batch_code, lr.retired_reason, lr.applied_qty
         FROM label_rolls lr LEFT JOIN batches b ON b.id = lr.batch_id
        WHERE lr.status = 'RETIRED'`
    ).all()
      .filter((r) => activeRealIds.has(r.id))
      .map((r) => ({
        roll_id: r.id, roll_code: r.roll_code, batch_code: r.batch_code,
        reason: r.retired_reason, applied_pending_review: r.applied_qty
      }));
    // 影子库中“正式库原为 SHIPPED、应用后将转为 PENDING_REVIEW”的出货单
    const shippedRealIds = new Set(db.prepare(
      "SELECT id FROM shipments WHERE status = 'SHIPPED'"
    ).all().map((r) => r.id));
    const { formatShipment } = require('./shipments');
    const pendingShipments = shadow.prepare(
      'SELECT id FROM shipments WHERE status = ? ORDER BY id'
    ).all('PENDING_REVIEW')
      .filter((r) => shippedRealIds.has(r.id))
      .map((r) => formatShipment(
        shadow.prepare('SELECT * FROM shipments WHERE id = ?').get(r.id), shadow));
    // 影子库中“正式库原为 ACTIVE、应用后将转为 STALE”的质量处置结论（旧结论保留、需重新评估）。
    const activeDispRealIds = new Set(db.prepare(
      "SELECT id FROM shipment_dispositions WHERE life_status = 'ACTIVE'"
    ).all().map((r) => r.id));
    const staleDispositions = shadow.prepare(
      `SELECT d.id AS disposition_id, d.shipment_id, s.shipment_code,
              d.decision, d.stale_reason AS reason
         FROM shipment_dispositions d
         JOIN shipments s ON s.id = d.shipment_id
        WHERE d.life_status = 'STALE' ORDER BY d.id`
    ).all()
      .filter((r) => activeDispRealIds.has(r.disposition_id))
      .map((r) => ({
        disposition_id: r.disposition_id,
        shipment_id: r.shipment_id,
        shipment_code: r.shipment_code,
        decision: r.decision,
        decision_text: r.decision === 'CONTINUE' ? '准予继续流转' : '召回',
        reason: r.reason
      }));
    const diff = diffSnapshots(before, after);
    diff.label_rolls_will_retire = retiredRolls;
    diff.summary.label_rolls_will_retire = retiredRolls.length;
    diff.shipments_will_pending = pendingShipments;
    diff.summary.shipments_will_pending = pendingShipments.length;
    diff.dispositions_will_stale = staleDispositions;
    diff.summary.dispositions_will_stale = staleDispositions.length;
    return { resolved, inserted, after, diff };
  } finally {
    shadow.close();
  }
}

// ---------- 对外入口 ----------
function preview(db, rawChanges) {
  const [normErr, changes] = normalizeChanges(rawChanges);
  if (normErr) throw normErr;

  // better-sqlite3 同步执行：取指纹与后续读之间不会穿插其它写入。
  const fingerprint = stateFingerprint(db);
  const result = simulate(db, changes);
  const hash = changesHash(result.resolved);
  const { version, expires_in_ms } = issueVersion(fingerprint, hash);

  return {
    ok: true,
    phase: 'PREVIEW',
    version,
    version_expires_in_ms: expires_in_ms,
    business_version: fingerprint.slice(0, 12), // 便于人工核对的业务版本短码
    changes: publicChanges(result.resolved),
    inserted_clean_events: result.inserted,
    diff: result.diff
  };
}

function apply(db, body) {
  const [normErr, changes] = normalizeChanges(body && body.changes);
  if (normErr) throw normErr;

  const payload = parseVersion(body && body.version);

  // 先解析引用（未知事件/设备等在事务外即可明确拒绝，且不产生任何写入）
  const resolved = resolveChangeRefs(db, changes);
  const hash = changesHash(resolved);
  if (hash !== payload.ch) {
    throw new ReplanError(
      'CHANGES_MISMATCH',
      '提交的变更内容与预演时不一致：确认应用必须携带与预演完全相同的 changes'
    );
  }

  let response;
  const tx = db.transaction(() => {
    const currentFp = stateFingerprint(db);
    if (currentFp !== payload.fp) {
      throw new ReplanError(
        'VERSION_EXPIRED',
        '预演后正式数据已发生影响推导结果的写入，该预演版本已过期；请重新预演后再应用'
      );
    }
    const before = takeSnapshot(db);
    const inserted = applyChangesTo(db, resolved);

    const errors = validateAll(db);
    if (errors.length) {
      throw new ReplanError('REPLAN_REJECTED', '整组变更应用后的时间线校验未通过', errors);
    }
    const { invalidated, retiredRolls, pendingShipments, staleDispositions } = recompute(db);
    const after = takeSnapshot(db);
    const appliedDiff = diffSnapshots(before, after);
    appliedDiff.label_rolls_will_retire = retiredRolls.map((r) => ({
      roll_id: r.id, roll_code: r.roll_code, batch_code: r.batch_code,
      reason: r.reason, applied_pending_review: r.applied_pending_review
    }));
    appliedDiff.summary.label_rolls_will_retire = retiredRolls.length;
    // pendingShipments 已是完整出货单（含原因与快照明细）。
    appliedDiff.shipments_will_pending = pendingShipments;
    appliedDiff.summary.shipments_will_pending = pendingShipments.length;
    // 旧质量处置结论被标为需重新评估（只增不改，不自动生效）。
    appliedDiff.dispositions_will_stale = staleDispositions;
    appliedDiff.summary.dispositions_will_stale = staleDispositions.length;

    // 提交后再计算一次指纹，作为新的业务版本随结果返回。
    response = {
      ok: true,
      phase: 'APPLIED',
      applied_version: body.version,
      inserted_clean_events: inserted,
      invalidated,
      retired_rolls: retiredRolls,
      pending_shipments: pendingShipments,
      stale_dispositions: staleDispositions,
      diff: appliedDiff
    };
  });
  tx();

  // 事务提交后读取，指纹与事务内状态一致（若期间另有同步写入会在本事务之后串行）。
  response.business_version = stateFingerprint(db).slice(0, 12);
  return response;
}

module.exports = {
  ReplanError,
  preview,
  apply,
  // 导出供测试：
  normalizeChanges,
  stateFingerprint,
  takeSnapshot,
  diffSnapshots
};
