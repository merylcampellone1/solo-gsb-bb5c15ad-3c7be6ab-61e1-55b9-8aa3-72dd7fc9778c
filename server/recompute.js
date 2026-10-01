'use strict';
// 推导引擎：按时间顺序回放全部事件。
//   加工：产出过敏原 = 原料输入 ∪ 引用批次的产出 ∪ 设备当前残留；
//         随后设备残留更新为本次产出的过敏原（新鲜来源追加“设备残留”标记，
//         已在残留中的路径原样保留）。
//   已核实清洗：清空该设备残留。
// 回放后刷新派生表，并按“登记当时的过敏原集合”核对放行记录，
// 集合不同的有效放行置为失效并记录原因；
// 进而永久停用不再一致的标签卷，并把分配过这些停用卷的出货单置为待评估。

const MAX_PATHS_PER_ALLERGEN = 30;
const TRUNC_MARK = '…（来源路径过多，已截断）';

function sortedJson(arr) {
  return JSON.stringify([...new Set(arr)].sort((a, b) => a.localeCompare(b, 'zh')));
}

function addPath(map, allergen, p) {
  if (!map.has(allergen)) map.set(allergen, new Set());
  const set = map.get(allergen);
  if (set.size < MAX_PATHS_PER_ALLERGEN) set.add(p);
  else set.add(TRUNC_MARK);
}

function recompute(db) {
  const materials = new Map(
    db.prepare('SELECT id, code, name, allergens FROM materials').all()
      .map((m) => [m.id, { ...m, allergenList: JSON.parse(m.allergens || '[]') }])
  );
  const batches = new Map(
    db.prepare('SELECT id, code FROM batches').all().map((b) => [b.id, b])
  );
  const equipment = new Map(
    db.prepare('SELECT id, code, name FROM equipment').all().map((q) => [q.id, q])
  );

  const events = db.prepare(
    `SELECT id, event_time, type, equipment_id, batch_id, note
       FROM events ORDER BY event_time, id`
  ).all();

  const inputsByEvent = new Map();
  db.prepare('SELECT event_id, material_id, batch_id FROM process_inputs').all()
    .forEach((r) => {
      if (!inputsByEvent.has(r.event_id)) inputsByEvent.set(r.event_id, []);
      inputsByEvent.get(r.event_id).push(r);
    });

  // 设备状态：allergen -> Set<路径>
  const residue = new Map();
  const lastCleanAt = new Map();
  for (const qid of equipment.keys()) residue.set(qid, new Map());

  // 批次产出：allergen -> Set<路径>
  const batchResult = new Map();

  for (const ev of events) {
    const eqCode = (equipment.get(ev.equipment_id) || {}).code || `#${ev.equipment_id}`;

    if (ev.type === 'CLEAN') {
      residue.set(ev.equipment_id, new Map());
      lastCleanAt.set(ev.equipment_id, ev.event_time);
      continue;
    }

    const out = new Map();       // allergen -> Set<路径>（产出批次）
    const fresh = new Map();     // allergen -> Set<路径>（本次新带入，未含设备残留标记）
    const inputs = inputsByEvent.get(ev.id) || [];

    for (const inp of inputs) {
      if (inp.material_id != null) {
        const mat = materials.get(inp.material_id);
        if (!mat) continue;
        const base = `原料:${mat.name}(${mat.code})`;
        for (const a of mat.allergenList) {
          addPath(out, a, base);
          addPath(fresh, a, base);
        }
      } else if (inp.batch_id != null) {
        const refCode = (batches.get(inp.batch_id) || {}).code || `#${inp.batch_id}`;
        const refResult = batchResult.get(inp.batch_id);
        if (!refResult) continue; // 非法引用由校验阶段拦截
        for (const [a, paths] of refResult.entries()) {
          for (const p of paths) {
            const np = `${p} → 批次引用:${refCode}`;
            addPath(out, a, np);
            addPath(fresh, a, np);
          }
        }
      }
    }

    // 设备残留并入产出（路径原样，表明来自设备残留）
    const carried = residue.get(ev.equipment_id) || new Map();
    for (const [a, paths] of carried.entries()) {
      for (const p of paths) addPath(out, a, p);
    }

    batchResult.set(ev.batch_id, out);

    // 更新设备残留：本次产出的过敏原继续残留在设备上
    const newRes = new Map();
    for (const a of out.keys()) {
      const next = new Set();
      for (const p of fresh.get(a) || []) next.add(`${p} → 设备残留:${eqCode}`);
      for (const p of carried.get(a) || []) next.add(p); // 原有残留路径保留
      newRes.set(a, next);
    }
    residue.set(ev.equipment_id, newRes);
  }

  // ---- 持久化批次推导结果 ----
  const upBatch = db.prepare(
    `INSERT INTO batch_outputs (batch_id, allergens, paths_json)
     VALUES (@batch_id, @allergens, @paths_json)
     ON CONFLICT(batch_id) DO UPDATE SET
       allergens = excluded.allergens, paths_json = excluded.paths_json`
  );
  const keepBatches = new Set(batchResult.keys());
  for (const [bid, result] of batchResult.entries()) {
    const allergens = [...result.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    const pathsObj = {};
    for (const a of allergens) {
      pathsObj[a] = [...result.get(a)];
    }
    upBatch.run({
      batch_id: bid,
      allergens: JSON.stringify(allergens),
      paths_json: JSON.stringify(pathsObj)
    });
  }
  const stale = db.prepare('SELECT batch_id FROM batch_outputs').all()
    .map((r) => r.batch_id)
    .filter((bid) => !keepBatches.has(bid));
  const delOut = db.prepare('DELETE FROM batch_outputs WHERE batch_id = ?');
  for (const bid of stale) delOut.run(bid);

  // ---- 持久化设备残留 ----
  const upRes = db.prepare(
    `INSERT INTO equipment_residue (equipment_id, allergens, paths_json, last_cleaned_at)
     VALUES (@equipment_id, @allergens, @paths_json, @last_cleaned_at)
     ON CONFLICT(equipment_id) DO UPDATE SET
       allergens = excluded.allergens,
       paths_json = excluded.paths_json,
       last_cleaned_at = excluded.last_cleaned_at`
  );
  for (const qid of equipment.keys()) {
    const map = residue.get(qid) || new Map();
    const allergens = [...map.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    const pathsObj = {};
    for (const a of allergens) pathsObj[a] = [...map.get(a)];
    upRes.run({
      equipment_id: qid,
      allergens: JSON.stringify(allergens),
      paths_json: JSON.stringify(pathsObj),
      last_cleaned_at: lastCleanAt.get(qid) || null
    });
  }

  // ---- 核对放行：登记当时集合与最新推导不一致则失效（一次性，不自动恢复）----
  const releases = db.prepare(
    `SELECT r.id, r.batch_id, r.status, r.snapshot_allergens, b.code AS batch_code
       FROM releases r JOIN batches b ON b.id = r.batch_id
      WHERE r.status = 'ACTIVE'`
  ).all();
  const invalidated = [];
  const markInvalid = db.prepare(
    `UPDATE releases SET status = 'INVALIDATED', invalid_reason = ? WHERE id = ?`
  );
  for (const rel of releases) {
    const result = batchResult.get(rel.batch_id);
    if (!result) {
      const reason = '该批次的加工事件已不存在，无法重新推导过敏原';
      markInvalid.run(reason, rel.id);
      invalidated.push({ id: rel.id, batch_code: rel.batch_code, reason });
      continue;
    }
    const current = sortedJson([...result.keys()]);
    if (current !== rel.snapshot_allergens) {
      const oldSet = JSON.parse(rel.snapshot_allergens);
      const newSet = [...result.keys()];
      const added = newSet.filter((a) => !oldSet.includes(a));
      const removed = oldSet.filter((a) => !newSet.includes(a));
      const parts = [];
      if (added.length) parts.push(`新增：${added.join('、')}`);
      if (removed.length) parts.push(`移除：${removed.join('、')}`);
      const reason = `早期事件更正后重算，过敏原集合与放行登记时不同（${parts.join('；')}）`;
      markInvalid.run(reason, rel.id);
      invalidated.push({ id: rel.id, batch_code: rel.batch_code, reason });
    }
  }

  // ---- 标签卷同步停用（终态，不自动恢复）----
  // 触发条件（任一即永久停用）：
  //   绑定放行已失效/被删除、批次加工不存在、批次当前推导集合与卷的拟印集合不同
  //   （原料/加工事件变更、整组确认应用使集合改变等均经此路径生效）。
  // 延迟 require 以避免 labels <-> recompute 循环依赖。
  const { syncRollsAfterRecompute } = require('./labels');
  const retiredRolls = syncRollsAfterRecompute(db, batchResult);

  // ---- 出货单待评估：本次停用的卷若已分配给出货单，则相关单据置为待评估（终态不恢复）----
  const shipments = require('./shipments');
  const pendingShipments = shipments.syncPendingShipments(db);

  // ---- 质量处置结论核对：批次过敏原 / 有效放行 / 所用卷停用信息变化后，
  //      仍为 ACTIVE 的旧结论标为“需重新评估”（STALE，只增不改、不自动生效）----
  const evaluation = require('./evaluation');
  const staleDispositions = evaluation.syncStaleDispositions(db);

  return { invalidated, retiredRolls, pendingShipments, staleDispositions };
}

module.exports = { recompute, sortedJson };
