'use strict';
const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const { validateAll } = require('./validation');
const { recompute, sortedJson } = require('./recompute');
const { seedIfEmpty } = require('./seed');
const replan = require('./replan');
const labels = require('./labels');
const shipments = require('./shipments');
const evaluation = require('./evaluation');
const lots = require('./lots');
const { traceMaterial } = require('./trace');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = getDb();
if (process.env.SEED_DEMO !== 'false') {
  try {
    if (seedIfEmpty()) console.log('已初始化演示数据（设置 SEED_DEMO=false 可关闭）');
  } catch (err) {
    console.error('演示数据初始化失败：', err.message);
  }
}

// ---------- 读取：整页状态 ----------
app.get('/api/state', (req, res) => {
  const materials = db.prepare(
    'SELECT id, code, name, allergens FROM materials ORDER BY code'
  ).all().map((m) => ({
    ...m,
    allergens: JSON.parse(m.allergens),
    lots: db.prepare(
      `SELECT id, lot_code, supplier, note, status, flagged_reason, created_at
         FROM material_lots WHERE material_id = ? ORDER BY lot_code, id`
    ).all(m.id).map((l) => ({
      ...l,
      flagged: l.status === 'FLAGGED'
    }))
  }));

  const equipment = db.prepare(
    `SELECT e.id, e.code, e.name,
            COALESCE(r.allergens, '[]') AS allergens,
            COALESCE(r.paths_json, '{}') AS paths_json,
            r.last_cleaned_at
       FROM equipment e
       LEFT JOIN equipment_residue r ON r.equipment_id = e.id
      ORDER BY e.code`
  ).all().map((e) => ({
    id: e.id, code: e.code, name: e.name,
    allergens: JSON.parse(e.allergens),
    paths: JSON.parse(e.paths_json),
    last_cleaned_at: e.last_cleaned_at
  }));

  const events = db.prepare(
    `SELECT ev.id, ev.event_time, ev.type, ev.equipment_id, ev.note,
            ev.batch_id, b.code AS batch_code,
            bo.allergens AS out_allergens,
            bo.paths_json AS out_paths
       FROM events ev
       LEFT JOIN batches b ON b.id = ev.batch_id
       LEFT JOIN batch_outputs bo ON bo.batch_id = ev.batch_id
      ORDER BY ev.event_time, ev.id`
  ).all().map((ev) => ({
    id: ev.id,
    event_time: ev.event_time,
    type: ev.type,
    equipment_id: ev.equipment_id,
    note: ev.note,
    batch_id: ev.batch_id,
    batch_code: ev.batch_code,
    out_allergens: ev.out_allergens ? JSON.parse(ev.out_allergens) : [],
    out_paths: ev.out_paths ? JSON.parse(ev.out_paths) : {},
    inputs: db.prepare(
      `SELECT pi.material_id, pi.batch_id AS ref_batch_id, pi.material_lot_id,
              m.name AS material_name, m.code AS material_code,
              m.allergens AS material_allergens,
              rb.code AS ref_batch_code,
              ml.lot_code AS material_lot_code,
              ml.status AS material_lot_status
         FROM process_inputs pi
         LEFT JOIN materials m ON m.id = pi.material_id
         LEFT JOIN batches rb ON rb.id = pi.batch_id
         LEFT JOIN material_lots ml ON ml.id = pi.material_lot_id
        WHERE pi.event_id = ?`
    ).all(ev.id).map((r) => ({
      material_id: r.material_id,
      ref_batch_id: r.ref_batch_id,
      material_lot_id: r.material_lot_id,
      lot_known: r.material_id != null && r.material_lot_id != null,
      material_code: r.material_code,
      material_name: r.material_name,
      material_allergens: r.material_allergens ? JSON.parse(r.material_allergens) : null,
      material_lot_code: r.material_lot_code,
      material_lot_status: r.material_lot_status,
      ref_batch_code: r.ref_batch_code
    }))
  }));

  const batches = db.prepare(
    `SELECT b.id, b.code, bo.allergens, bo.paths_json,
            ev.event_time AS produced_at, ev.equipment_id, eq.code AS equipment_code, eq.name AS equipment_name
       FROM batches b
       LEFT JOIN batch_outputs bo ON bo.batch_id = b.id
       LEFT JOIN events ev ON ev.batch_id = b.id
       LEFT JOIN equipment eq ON eq.id = ev.equipment_id
      ORDER BY ev.event_time, b.code`
  ).all().map((b) => ({
    id: b.id,
    code: b.code,
    produced_at: b.produced_at,
    equipment_id: b.equipment_id,
    equipment_code: b.equipment_code,
    equipment_name: b.equipment_name,
    allergens: b.allergens ? JSON.parse(b.allergens) : [],
    paths: b.paths_json ? JSON.parse(b.paths_json) : {},
    releases: db.prepare(
      `SELECT id, released_at, released_by, snapshot_allergens, status, invalid_reason
         FROM releases WHERE batch_id = ? ORDER BY released_at DESC, id DESC`
    ).all(b.id).map((r) => ({
      ...r,
      snapshot_allergens: JSON.parse(r.snapshot_allergens)
    }))
  }));

  const label_rolls = db.prepare(
    `SELECT lr.*, b.code AS batch_code,
            r.released_at AS release_at, r.released_by AS release_by,
            COALESCE((SELECT SUM(qty) FROM shipment_items si WHERE si.roll_id = lr.id), 0)
              AS allocated_qty
       FROM label_rolls lr
       LEFT JOIN batches b ON b.id = lr.batch_id
       LEFT JOIN releases r ON r.id = lr.release_id
      ORDER BY b.code, lr.roll_code`
  ).all().map((r) => ({
    ...labels.formatRoll(r),
    batch_code: r.batch_code,
    release_at: r.release_at,
    release_by: r.release_by,
    allocated_qty: r.allocated_qty || 0,
    // 可出货余额：仅未停用卷的“已贴用 - 累计已分配”；停卷余量冻结不可出货。
    shippable_qty: r.status === 'ACTIVE'
      ? Math.max(r.applied_qty - (r.allocated_qty || 0), 0)
      : 0
  }));

  const shipment_rows = db.prepare('SELECT * FROM shipments ORDER BY id DESC').all();
  const shipments_list = shipment_rows.map((s) => shipments.formatShipment(s, db));

  res.json({ materials, equipment, events, batches, label_rolls, shipments: shipments_list });
});

// ---------- 通用：在事务中写事件集 -> 校验 -> 重算 ----------
function mutateEvents(fn) {
  const d = db;
  const result = d.transaction(() => {
    const ret = fn(d);
    const errors = validateAll(d);
    if (errors.length) {
      const err = new Error('VALIDATION_FAILED');
      err.errors = errors;
      throw err; // 回滚整次提交
    }
    const recomputeResult = recompute(d);
    return {
      ret,
      invalidated: recomputeResult.invalidated,
      retired_rolls: recomputeResult.retiredRolls,
      pending_shipments: recomputeResult.pendingShipments,
      stale_dispositions: recomputeResult.staleDispositions
    };
  })();
  return result;
}

function badRequest(res, err) {
  if (err && err.message === 'VALIDATION_FAILED') {
    return res.status(400).json({ error: '提交被拒绝（整次提交已回滚）', details: err.errors });
  }
  return res.status(400).json({ error: err && err.message ? err.message : String(err) });
}

// ---------- 原料 ----------
app.post('/api/materials', (req, res) => {
  try {
    const { code, name, allergens } = normalizeMaterial(req.body);
    const info = db.prepare(
      'INSERT INTO materials (code, name, allergens) VALUES (?,?,?)'
    ).run(code, name, JSON.stringify(allergens));
    res.json({ id: info.lastInsertRowid });
  } catch (err) { badRequest(res, err); }
});

app.put('/api/materials/:id', (req, res) => {
  try {
    const { code, name, allergens } = normalizeMaterial(req.body);
    const info = db.prepare(
      'UPDATE materials SET code=?, name=?, allergens=? WHERE id=?'
    ).run(code, name, JSON.stringify(allergens), req.params.id);
    if (!info.changes) return res.status(404).json({ error: '原料不存在' });
    // 过敏原被修改会改变批次推导结果，需要全量重算
    const { invalidated, retired_rolls, pending_shipments, stale_dispositions } = mutateEvents(() => {});
    res.json({ ok: true, invalidated, retired_rolls, pending_shipments, stale_dispositions });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/materials/:id', (req, res) => {
  try {
    const used = db.prepare(
      'SELECT COUNT(*) AS c FROM process_inputs WHERE material_id=?'
    ).get(req.params.id).c;
    if (used > 0) return res.status(400).json({ error: '该原料已被加工事件引用，请先更正相关事件' });
    const lotCount = db.prepare(
      'SELECT COUNT(*) AS c FROM material_lots WHERE material_id=?'
    ).get(req.params.id).c;
    if (lotCount > 0) {
      return res.status(400).json({ error: `该原料下仍登记有 ${lotCount} 个供应批号，请先删除未被投料引用的批号` });
    }
    const info = db.prepare('DELETE FROM materials WHERE id=?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: '原料不存在' });
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

function normalizeMaterial(body) {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code) throw new Error('原料编码不能为空');
  if (!name) throw new Error('原料名称不能为空');
  const allergens = [...new Set(
    (Array.isArray(body.allergens) ? body.allergens : [])
      .map((a) => String(a).trim()).filter(Boolean)
  )];
  return { code, name, allergens };
}

// ---------- 设备 ----------
app.post('/api/equipment', (req, res) => {
  try {
    const { code, name } = normalizeEquipment(req.body);
    const info = db.prepare('INSERT INTO equipment (code, name) VALUES (?,?)').run(code, name);
    db.prepare(
      `INSERT INTO equipment_residue (equipment_id, allergens, paths_json, last_cleaned_at)
       VALUES (?,'[]','{}',NULL)`
    ).run(info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { badRequest(res, err); }
});

app.put('/api/equipment/:id', (req, res) => {
  try {
    const { code, name } = normalizeEquipment(req.body);
    const info = db.prepare('UPDATE equipment SET code=?, name=? WHERE id=?')
      .run(code, name, req.params.id);
    if (!info.changes) return res.status(404).json({ error: '设备不存在' });
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/equipment/:id', (req, res) => {
  try {
    const used = db.prepare('SELECT COUNT(*) AS c FROM events WHERE equipment_id=?')
      .get(req.params.id).c;
    if (used > 0) return res.status(400).json({ error: '该设备下仍有事件，无法删除' });
    db.prepare('DELETE FROM equipment WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { badRequest(res, err); }
});

function normalizeEquipment(body) {
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  if (!code) throw new Error('设备编码不能为空');
  if (!name) throw new Error('设备名称不能为空');
  return { code, name };
}

// ---------- 原料供应批号 ----------
app.post('/api/material-lots', (req, res) => {
  try {
    res.json(lots.createLot(db, req.body || {}));
  } catch (err) { sendLotError(res, err); }
});

app.get('/api/material-lots', (req, res) => {
  let material_id = null;
  if (req.query.material_id !== undefined) {
    material_id = parseInt(req.query.material_id, 10);
    if (!Number.isInteger(material_id)) {
      return res.status(400).json({ error: 'material_id 不合法', code: 'INVALID_REQUEST' });
    }
  }
  res.json(lots.listLots(db, { material_id }));
});

// 供应商通报异常：标记批号（仅留痕，不自动改变任何放行/卷/出货/处置结论）
app.post('/api/material-lots/:id/flag', (req, res) => {
  try {
    res.json(lots.flagLot(db, parseInt(req.params.id, 10), req.body || {}));
  } catch (err) { sendLotError(res, err); }
});

// 解除异常标记
app.post('/api/material-lots/:id/unflag', (req, res) => {
  try {
    res.json(lots.unflagLot(db, parseInt(req.params.id, 10), req.body || {}));
  } catch (err) { sendLotError(res, err); }
});

app.delete('/api/material-lots/:id', (req, res) => {
  try {
    res.json(lots.deleteLot(db, parseInt(req.params.id, 10)));
  } catch (err) { sendLotError(res, err); }
});

function sendLotError(res, err) {
  if (err && err.name === 'LotError') {
    if (err.code === 'LOT_NOT_FOUND' || err.code === 'MATERIAL_NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code, details: err.details });
    }
    return res.status(400).json({ error: err.message, code: err.code, details: err.details });
  }
  return badRequest(res, err);
}

// ---------- 原料供应批号流向追溯（只读） ----------
// GET /api/trace/material-lot?material_id=&lot_id= 或 &lot_code=
// 省略批号参数 = 查询“该原料批号未知”而无法排除的流向。
app.get('/api/trace/material-lot', (req, res) => {
  try {
    res.json(traceMaterial(db, {
      material_id: req.query.material_id,
      lot_id: req.query.lot_id,
      lot_code: req.query.lot_code,
      path_limit: req.query.path_limit
    }));
  } catch (err) {
    if (err && err.name === 'TraceError') {
      return res.status(err.status).json({
        error: err.message, code: err.code, details: err.details
      });
    }
    console.error(err);
    return res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
  }
});

// ---------- 事件 ----------
// body: { event_time, type, equipment_id, batch_code, note, material_ids:[], ref_batch_ids:[] }
app.post('/api/events', (req, res) => {
  let materialInputs;
  try {
    const body = normalizeEventBody(req.body);
    // 带供应批号的原料输入在事务前解析（批号不存在 / 与原料不匹配在此明确拒绝）。
    materialInputs = body.material_inputs !== undefined
      ? lots.resolveMaterialInputs(db, body.material_inputs)
      : body.material_ids.map((material_id) => ({ material_id, material_lot_id: null }));
    const { ret, invalidated, retired_rolls, pending_shipments, stale_dispositions } = mutateEvents((d) => {
      let batchId = null;
      if (body.type === 'PROCESS') {
        batchId = d.prepare('INSERT INTO batches (code) VALUES (?)')
          .run(body.batch_code).lastInsertRowid;
      }
      const eid = d.prepare(
        'INSERT INTO events (event_time, type, equipment_id, batch_id, note) VALUES (?,?,?,?,?)'
      ).run(body.event_time, body.type, body.equipment_id, batchId, body.note).lastInsertRowid;
      if (body.type === 'PROCESS') {
        for (const inp of materialInputs) {
          d.prepare(
            'INSERT INTO process_inputs (event_id, material_id, material_lot_id) VALUES (?,?,?)'
          ).run(eid, inp.material_id, inp.material_lot_id);
        }
        for (const bid of body.ref_batch_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)')
            .run(eid, bid);
        }
      }
      return eid;
    });
    res.json({ id: ret, invalidated, retired_rolls, pending_shipments, stale_dispositions });
  } catch (err) { sendEventError(res, err); }
});

app.put('/api/events/:id', (req, res) => {
  try {
    const body = normalizeEventBody(req.body, true);
    const existing = db.prepare('SELECT id, type, batch_id FROM events WHERE id=?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: '事件不存在' });
    if (body.type !== existing.type) {
      return res.status(400).json({ error: '事件类型（加工/清洗）不可变更，请删除后新建' });
    }
    // 加工事件全量覆盖原料输入（含批号）：批号合法性在事务前解析，非法即拒绝。
    const materialInputs = body.type === 'PROCESS'
      ? (body.material_inputs !== undefined
        ? lots.resolveMaterialInputs(db, body.material_inputs)
        : body.material_ids.map((material_id) => ({ material_id, material_lot_id: null })))
      : [];
    const { invalidated, retired_rolls, pending_shipments, stale_dispositions } = mutateEvents((d) => {
      if (body.type === 'PROCESS') {
        d.prepare('UPDATE batches SET code=? WHERE id=?')
          .run(body.batch_code, existing.batch_id);
        d.prepare('DELETE FROM process_inputs WHERE event_id=?').run(existing.id);
        for (const inp of materialInputs) {
          d.prepare(
            'INSERT INTO process_inputs (event_id, material_id, material_lot_id) VALUES (?,?,?)'
          ).run(existing.id, inp.material_id, inp.material_lot_id);
        }
        for (const bid of body.ref_batch_ids) {
          d.prepare('INSERT INTO process_inputs (event_id, batch_id) VALUES (?,?)')
            .run(existing.id, bid);
        }
      }
      d.prepare(
        'UPDATE events SET event_time=?, equipment_id=?, note=? WHERE id=?'
      ).run(body.event_time, body.equipment_id, body.note, existing.id);
    });
    res.json({ ok: true, invalidated, retired_rolls, pending_shipments, stale_dispositions });
  } catch (err) { sendEventError(res, err); }
});

// 事件写入错误：批号档案类错误带明确 code；其余沿用原 400 形状。
function sendEventError(res, err) {
  if (err && err.name === 'LotError') {
    return res.status(400).json({ error: err.message, code: err.code, details: err.details });
  }
  return badRequest(res, err);
}

app.delete('/api/events/:id', (req, res) => {
  try {
    const existing = db.prepare(
      'SELECT ev.id, ev.type, ev.batch_id, b.code AS batch_code FROM events ev LEFT JOIN batches b ON b.id = ev.batch_id WHERE ev.id=?'
    ).get(req.params.id);
    if (!existing) return res.status(404).json({ error: '事件不存在' });
    // 批次连带删除时需要保留标签卷（含核销流水）与出货单据：这些表对 batches/label_rolls
    // 带外键，而 foreign_keys pragma 在事务内为 no-op，故在事务开始前临时关闭、结束后恢复。
    // 删除顺序已手工保证引用完整（先解绑卷、删事件与输入，再删批次；出货单 batch_id 置空）。
    const needDetach = existing.type === 'PROCESS' && existing.batch_id;
    if (needDetach) db.pragma('foreign_keys = OFF');
    let result;
    try {
      result = mutateEvents((d) => {
      if (existing.type === 'PROCESS' && existing.batch_id) {
        const referenced = d.prepare(
          'SELECT COUNT(*) AS c FROM process_inputs WHERE batch_id=?'
        ).get(existing.batch_id).c;
        if (referenced > 0) {
          throw new Error('该批次仍被后续加工引用，请先更正引用它的事件');
        }
        const hasRelease = d.prepare(
          'SELECT COUNT(*) AS c FROM releases WHERE batch_id=?'
        ).get(existing.batch_id).c;
        if (hasRelease) {
          throw new Error('该批次已有放行记录，请先删除相关放行记录后再删除加工事件');
        }
        // 兜底：批次连带删除时，其名下仍有效的标签卷永久停用（通常不会走到，因放行需先删）
        labels.deactivateForBatchDeletion(d, existing.batch_id, existing.batch_code);
        // 批次行将被删除（出货单 batch_id 置空，记录保留）；停卷后同步把相关出货单置为待评估。
        shipments.markPendingForRetirement(d);
        // 标签卷不随批次删除：解除对批次的外键引用（卷快照已保留在出货明细中）。
        d.prepare('UPDATE label_rolls SET batch_id = NULL WHERE batch_id = ?')
          .run(existing.batch_id);
        // 出货单的批次引用置空（shipment_versions/dispositions 不带外键，记录保留）。
        d.prepare('UPDATE shipments SET batch_id = NULL WHERE batch_id = ?')
          .run(existing.batch_id);
        // 先删加工事件（process_inputs 随事件级联），再删批次：
        // events.batch_id 为 NO ACTION 外键，批次必须在无事件引用时才能删除。
        d.prepare('DELETE FROM process_inputs WHERE event_id = ?').run(existing.id);
        d.prepare('DELETE FROM batch_outputs WHERE batch_id=?').run(existing.batch_id);
        d.prepare('DELETE FROM batches WHERE id=?').run(existing.batch_id);
      }
      d.prepare('DELETE FROM events WHERE id=?').run(existing.id);
      });
    } finally {
      if (needDetach) db.pragma('foreign_keys = ON');
    }
    const { invalidated, retired_rolls, pending_shipments, stale_dispositions } = result;
    res.json({ ok: true, invalidated, retired_rolls, pending_shipments, stale_dispositions });
  } catch (err) { badRequest(res, err); }
});

function normalizeEventBody(body, isUpdate = false) {
  const type = String(body.type || '').toUpperCase();
  if (type !== 'PROCESS' && type !== 'CLEAN') throw new Error('事件类型必须为 PROCESS 或 CLEAN');
  const event_time = String(body.event_time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(event_time)) {
    throw new Error('事件时间格式应为 YYYY-MM-DDTHH:MM，例如 2026-09-30T08:00');
  }
  const equipment_id = parseInt(body.equipment_id, 10);
  if (!Number.isInteger(equipment_id)) throw new Error('请选择设备');
  const note = String(body.note || '').trim();

  const out = { type, event_time, equipment_id, note,
    material_ids: [], material_inputs: undefined, ref_batch_ids: [] };
  if (type === 'PROCESS') {
    const batch_code = String(body.batch_code || '').trim();
    if (!batch_code) throw new Error('产出批次编码不能为空');
    out.batch_code = batch_code;
    out.material_ids = idList(body.material_ids);
    out.ref_batch_ids = idList(body.ref_batch_ids);
    // 新形态：material_inputs: [{ material_id, lot_id?|lot_code? }]，
    // 同一原料可出现多次（一次加工使用多个批号）；省略批号的条目记为“批号未知”。
    if (body.material_inputs !== undefined) {
      if (!Array.isArray(body.material_inputs)) {
        throw new Error('material_inputs 必须是数组，每项为 {material_id, lot_id?|lot_code?}');
      }
      // 仅做形状与原料 id 提取；批号存在性/归属由 lots.resolveMaterialInputs 做权威校验。
      out.material_inputs = body.material_inputs.map((inp, idx) => {
        if (!inp || typeof inp !== 'object') {
          throw new Error(`material_inputs[${idx}] 必须是对象`);
        }
        const mid = parseInt(inp.material_id, 10);
        if (!Number.isInteger(mid)) {
          throw new Error(`material_inputs[${idx}] 缺少合法的 material_id`);
        }
        return {
          material_id: mid,
          lot_id: inp.lot_id !== undefined ? inp.lot_id : undefined,
          lot_code: inp.lot_code !== undefined ? inp.lot_code : undefined
        };
      });
      // 同时携带旧式 material_ids 时，二者原料集合必须一致（防止调用方误以为旧字段仍生效）。
      if (out.material_ids.length) {
        const fromInputs = [...new Set(out.material_inputs.map((x) => x.material_id))].sort((a, b) => a - b);
        const legacy = [...new Set(out.material_ids)].sort((a, b) => a - b);
        const sameSet = fromInputs.length === legacy.length &&
          fromInputs.every((v, i) => v === legacy[i]);
        if (!sameSet) {
          throw new Error(
            'material_inputs 与 material_ids 同时提供时，涉及的原料集合必须完全一致；' +
            '只传 material_ids 时所有输入记为批号未知'
          );
        }
      } else {
        out.material_ids = [...new Set(out.material_inputs.map((x) => x.material_id))];
      }
    }
  }
  return out;
}

function idList(v) {
  return [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Number.isInteger))];
}

// ---------- 放行 ----------
// body: { batch_id, released_at, released_by } —— 以“当时推导结果”登记
app.post('/api/releases', (req, res) => {
  try {
    const batch_id = parseInt(req.body.batch_id, 10);
    if (!Number.isInteger(batch_id)) throw new Error('请选择批次');
    const released_at = String(req.body.released_at || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(released_at)) {
      throw new Error('放行时间格式应为 YYYY-MM-DDTHH:MM');
    }
    const released_by = String(req.body.released_by || '').trim() || '未署名';

    const out = db.prepare('SELECT allergens FROM batch_outputs WHERE batch_id=?').get(batch_id);
    const ev = db.prepare('SELECT id FROM events WHERE batch_id=?').get(batch_id);
    if (!out || !ev) return res.status(400).json({ error: '该批次尚无加工记录，无法放行' });

    const snapshot = sortedJson(JSON.parse(out.allergens));
    let info;
    // 新增放行可能让旧处置上下文（有效放行集合）变化：同一事务内核对旧结论是否需重新评估。
    const txResult = db.transaction(() => {
      info = db.prepare(
        `INSERT INTO releases (batch_id, released_at, released_by, snapshot_allergens, status, created_event_seq)
         VALUES (?,?,?,?,'ACTIVE',(SELECT COUNT(*) FROM events))`
      ).run(batch_id, released_at, released_by, snapshot);
      return evaluation.syncStaleDispositions(db);
    })();
    res.json({ id: info.lastInsertRowid, stale_dispositions: txResult });
  } catch (err) { badRequest(res, err); }
});

app.delete('/api/releases/:id', (req, res) => {
  const rel = db.prepare('SELECT id FROM releases WHERE id=?').get(req.params.id);
  if (!rel) return res.status(404).json({ error: '放行记录不存在' });
  // 放行删除：其名下仍有效的标签卷先永久停用，再把相关出货单置为待评估（同一事务原子完成）。
  // 字段/响应形状保持 ok:true 不变，附加 retired_rolls 与 pending_shipments；
  // 出货明细中的放行标识（release_id/release_at/release_by 快照）保留不删。
  let retired = [];
  let pending = [];
  let staleDispositions = [];
  db.transaction(() => {
    const { rolls, reason } = labels.deactivateForReleaseDeletion(db, rel.id);
    retired = rolls.map((x) => ({ id: x.id, roll_code: x.roll_code, reason }));
    pending = shipments.markPendingForRetirement(db);
    // 放行删除直接改变“有效放行”，且上面已停用名下卷：同一事务内把旧结论标为需重新评估。
    staleDispositions = evaluation.syncStaleDispositions(db);
    db.prepare('DELETE FROM releases WHERE id=?').run(rel.id);
    // 删除后 active_releases / release_exists 再次变化，补核对一次（删除本身也在同一事务内）。
    staleDispositions = staleDispositions.concat(evaluation.syncStaleDispositions(db));
  })();
  res.json({
    ok: true,
    retired_rolls: retired,
    pending_shipments: pending,
    stale_dispositions: staleDispositions
  });
});

// ---------- 过敏原标签卷 ----------
// 登记一卷：body { batch_id, release_id, allergens:[], print_qty, registered_by?, registered_at? }
// 拟印集合必须与当前批次推导结果、所选有效放行快照完全一致。
app.post('/api/label-rolls', (req, res) => {
  try {
    res.json(labels.registerRoll(db, req.body || {}));
  } catch (err) { sendLabelError(res, err); }
});

// 核销贴用/作废：body { expected_revision, applied, voided, used_by?, used_at? }
// 旧修订号/负数/超量/停用卷均整次拒绝（事务回滚，修订号不前进）。
app.post('/api/label-rolls/:id/consume', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '卷号不合法' });
  try {
    res.json(labels.consumeRoll(db, id, req.body || {}));
  } catch (err) { sendLabelError(res, err); }
});

function sendLabelError(res, err) {
  if (err && err.name === 'LabelError') {
    const status = (err.code === 'REVISION_MISMATCH' || err.code === 'OVER_LIMIT' ||
      err.code === 'ROLL_RETIRED') ? 409 : 400;
    if (err.code === 'ROLL_NOT_FOUND') return res.status(404).json({ error: err.message, code: err.code });
    return res.status(status).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }
  console.error(err);
  return res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
}

// ---------- 包装出货 ----------
// 出货确认：body { batch_id, ship_qty, shipped_by?, shipped_at?,
//                  allocations:[{ roll_id, qty }] }
// 任一条件不满足（卷不属于该批次 / 卷已停用 / 放行失效或删除 / 分配和≠出货量 /
// 累计分配超已贴用）整单事务回滚，不占用任何数量。
app.post('/api/shipments', (req, res) => {
  try {
    res.json(shipments.createShipment(db, req.body || {}));
  } catch (err) { sendShipmentError(res, err); }
});

// 出货单列表：?batch_id=、?status=SHIPPED|PENDING_REVIEW（均可选）
app.get('/api/shipments', (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    if (status && status !== 'SHIPPED' && status !== 'PENDING_REVIEW') {
      return res.status(400).json({
        error: 'status 仅支持 SHIPPED 或 PENDING_REVIEW',
        code: 'INVALID_REQUEST'
      });
    }
    let batch_id = null;
    if (req.query.batch_id !== undefined) {
      batch_id = parseInt(req.query.batch_id, 10);
      if (!Number.isInteger(batch_id)) {
        return res.status(400).json({ error: 'batch_id 不合法', code: 'INVALID_REQUEST' });
      }
    }
    res.json(shipments.listShipments(db, { batch_id, status }));
  } catch (err) { sendShipmentError(res, err); }
});

// 单张出货单：/api/shipments/:idOrCode（数字 id 或 SHIP-0001 卷式单号）
app.get('/api/shipments/:idOrCode', (req, res) => {
  const key = String(req.params.idOrCode || '').trim();
  let s = null;
  if (/^\d+$/.test(key)) s = shipments.getShipment(db, parseInt(key, 10));
  else s = shipments.getShipmentByCode(db, key);
  if (!s) return res.status(404).json({ error: '出货单不存在', code: 'SHIPMENT_NOT_FOUND' });
  res.json(s);
});

// 批次可出货余额：/api/batches/:id/shipment-balance
// 可出货余额 = 该批次所有未停用卷 max(已贴用 - 累计已分配,0) 之和。
app.get('/api/batches/:id/shipment-balance', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: '批次 id 不合法', code: 'INVALID_REQUEST' });
  }
  try {
    res.json(shipments.batchBalance(db, id));
  } catch (err) { sendShipmentError(res, err); }
});

// 全部批次可出货余额
app.get('/api/shipment-balances', (req, res) => {
  res.json(shipments.allBalances(db));
});

// ---------- 出货质量处置（整单） ----------
// 查询评估视图：出货快照（过敏原/逐卷分配/放行快照）、当前批次过敏原/有效放行/所用卷停用原因、
// 准予继续流转条件判定，以及查询时取得的状态版本（签名令牌，提交时原样回传）。
app.get('/api/shipments/:idOrCode/evaluation', (req, res) => {
  try {
    res.json(evaluation.getEvaluation(db, req.params.idOrCode));
  } catch (err) { sendEvaluationError(res, err); }
});

// 提交整单处置：body { decision:'CONTINUE'|'RECALL', decided_by, basis, version, decided_at? }
// 事务内核对最新状态版本与上下文指纹；过期拒绝且不产生记录；记录只增不改。
app.post('/api/shipments/:idOrCode/dispositions', (req, res) => {
  try {
    res.json(evaluation.submitDisposition(db, req.params.idOrCode, req.body || {}));
  } catch (err) { sendEvaluationError(res, err); }
});

function sendEvaluationError(res, err) {
  if (err && err.name === 'EvaluationError') {
    if (err.code === 'SHIPMENT_NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code, details: err.details });
    }
    const conflict = err.code === 'VERSION_EXPIRED' || err.code === 'CONTINUE_NOT_ALLOWED' ||
      err.code === 'SHIPMENT_NOT_REVIEWABLE' || err.code === 'DISPOSITION_EXISTS';
    return res.status(conflict ? 409 : 400).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }
  console.error(err);
  return res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
}

function sendShipmentError(res, err) {
  if (err && err.name === 'ShipmentError') {
    if (err.code === 'ROLL_NOT_FOUND' || err.code === 'SHIPMENT_NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code, details: err.details });
    }
    const status = (err.code === 'ROLL_RETIRED' || err.code === 'RELEASE_INACTIVE' ||
      err.code === 'OVER_APPLIED') ? 409 : 400;
    return res.status(status).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }
  console.error(err);
  return res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
}

// ---------- 换线整组预演 / 确认应用 ----------
// 预演：在内存影子库上应用整组变更并全量重算，只返回差异与业务版本，不写正式数据。
app.post('/api/replan/preview', (req, res) => {
  try {
    res.json(replan.preview(db, (req.body || {}).changes));
  } catch (err) { sendReplanError(res, err); }
});

// 确认应用：必须携带预演版本与完全相同的 changes，一次事务内重新校验、重算并落库。
app.post('/api/replan/apply', (req, res) => {
  try {
    res.json(replan.apply(db, req.body || {}));
  } catch (err) { sendReplanError(res, err); }
});

function sendReplanError(res, err) {
  if (err && err.name === 'ReplanError') {
    // 预演版本过期/签名失效/内容不一致：冲突类语义，明确拒绝且不改动任何数据。
    const status = err.code === 'VERSION_EXPIRED' || err.code === 'CHANGES_MISMATCH'
      ? 409 : 400;
    return res.status(status).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }
  console.error(err);
  return res.status(500).json({ error: err && err.message ? err.message : '服务器内部错误' });
}

// 兼容前端对未知路由回退到首页
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  console.log(`过敏原追踪系统已启动: http://localhost:${PORT}`);
});
