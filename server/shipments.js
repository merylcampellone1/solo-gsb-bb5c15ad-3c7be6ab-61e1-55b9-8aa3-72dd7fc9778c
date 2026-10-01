'use strict';
// 包装出货：按批次将“已贴用标签”按卷分配给出货单。
//
// 出货确认（整单事务化，违反任意一条则整单回滚拒绝、不占用任何数量）：
//   必须录入：批次、正整数出货量、各卷分配张数、操作人（出货时间可选，默认当前）。
//   每个被分配的卷必须：
//     1) 属于该批次；
//     2) 未停用（status='ACTIVE'）；
//     3) 绑定有效放行（release 仍存在且 ACTIVE）；
//   各卷分配张数之和必须恰好等于出货量；
//   每卷“累计已分配数 + 本次分配”不得超过该卷“已贴用数”（作废不算贴用）。
//   成功后返回出货单号（SHIP-0001 起）与状态（SHIPPED），
//   并保存当时的放行标识、过敏原集合、卷号与修订号（明细快照，只增不改）。
//
// 待评估（终态，不自动恢复）：
//   原料或事件变更、整组换线确认应用、或放行删除导致某卷停用时，
//   分配过该卷的已出货单全部置为 PENDING_REVIEW 并记录原因；
//   已 PENDING_REVIEW 的单据不会因后续任何更正恢复为 SHIPPED。
//   卷停用后其尚未分配的已贴张数自然不可再出货（出货只接受 ACTIVE 卷）。

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class ShipmentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ShipmentError';
    this.code = code;
    this.details = details || [];
  }
}

function posInt(v, field) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ShipmentError('INVALID_REQUEST', `${field}必须是大于 0 的正整数`);
  }
  return n;
}

function sortedSet(list) {
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

// ---------- 出货确认 ----------
// body: { batch_id, ship_qty, shipped_by?, shipped_at?,
//         allocations: [{ roll_id, qty }] }
function createShipment(db, body) {
  body = body || {};
  const batch_id = parseInt(body.batch_id, 10);
  if (!Number.isInteger(batch_id)) {
    throw new ShipmentError('INVALID_REQUEST', '请录入出货批次');
  }
  const ship_qty = posInt(body.ship_qty, '出货量');
  if (ship_qty > 1e9) throw new ShipmentError('INVALID_REQUEST', '出货量超出允许范围');

  const shipped_by = String(body.shipped_by || '').trim();
  if (!shipped_by) throw new ShipmentError('INVALID_REQUEST', '请录入操作人');

  const shipped_at = String(body.shipped_at || '').trim();
  if (shipped_at && !TIME_RE.test(shipped_at)) {
    throw new ShipmentError('INVALID_REQUEST', '出货时间格式应为 YYYY-MM-DDTHH:MM');
  }

  const rawAllocs = body.allocations;
  if (!Array.isArray(rawAllocs) || rawAllocs.length === 0) {
    throw new ShipmentError('INVALID_REQUEST', '请至少录入一卷的分配张数');
  }

  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batch_id);
  if (!batch) throw new ShipmentError('BATCH_NOT_FOUND', '出货批次不存在');

  // 规范化并去重：同一卷在一张出货单中只能出现一次。
  const allocations = [];
  const seenRolls = new Set();
  rawAllocs.forEach((a, idx) => {
    if (!a || typeof a !== 'object') {
      throw new ShipmentError('INVALID_REQUEST', `allocations[${idx}] 必须是 {roll_id, qty} 对象`);
    }
    const roll_id = parseInt(a.roll_id, 10);
    if (!Number.isInteger(roll_id)) {
      throw new ShipmentError('INVALID_REQUEST', `allocations[${idx}] 缺少合法的卷号 roll_id`);
    }
    if (seenRolls.has(roll_id)) {
      throw new ShipmentError('INVALID_REQUEST', `卷 #${roll_id} 在本出货单中被重复分配`);
    }
    seenRolls.add(roll_id);
    const qty = posInt(a.qty, `卷 #${roll_id} 的分配张数`);
    if (qty > 1e9) throw new ShipmentError('INVALID_REQUEST', '分配张数超出允许范围');
    allocations.push({ roll_id, qty });
  });

  const totalAlloc = allocations.reduce((s, a) => s + a.qty, 0);

  // 预校验给出准确的中文拒绝原因；事务内会再次读取最新数据做权威判定。
  // 优先级：卷不存在(404) -> 卷不属于该批次(400) -> 停用/放行失效(409) -> 超已贴(409)。
  const rollCache = new Map();
  const getRoll = (id) => {
    if (!rollCache.has(id)) {
      rollCache.set(id, db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id));
    }
    return rollCache.get(id);
  };
  for (const a of allocations) {
    const roll = getRoll(a.roll_id);
    if (!roll) throw new ShipmentError('ROLL_NOT_FOUND', `标签卷 #${a.roll_id} 不存在`);
    if (roll.batch_id !== batch_id) {
      throw new ShipmentError(
        'ROLL_BATCH_MISMATCH',
        `卷 ${roll.roll_code || ('#' + roll.id)} 不属于批次 ${batch.code}，不能在该批次出货单中分配`
      );
    }
    if (roll.status !== 'ACTIVE') {
      throw new ShipmentError(
        'ROLL_RETIRED',
        `卷 ${roll.roll_code} 已永久停用（${roll.retired_reason || '见停用原因'}），` +
        '其标签不得再出货',
        [roll.retired_reason]
      );
    }
    const release = roll.release_id == null ? null
      : db.prepare('SELECT id, status FROM releases WHERE id = ?').get(roll.release_id);
    if (!release) {
      throw new ShipmentError(
        'RELEASE_INACTIVE',
        `卷 ${roll.roll_code} 绑定的放行记录已删除，不能出货`
      );
    }
    if (release.status !== 'ACTIVE') {
      throw new ShipmentError(
        'RELEASE_INACTIVE',
        `卷 ${roll.roll_code} 绑定的放行记录已失效，不能出货`
      );
    }
  }
  if (totalAlloc !== ship_qty) {
    throw new ShipmentError(
      'ALLOCATION_MISMATCH',
      `各卷分配张数之和 ${totalAlloc} 与出货量 ${ship_qty} 不一致；整单拒绝、不占用数量`
    );
  }

  const inserted = { id: null };
  const tx = db.transaction(() => {
    // ---- 事务内权威复核（最新数据 + 锁内串行）----
    const resolved = [];
    for (const a of allocations) {
      const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(a.roll_id);
      if (!roll) throw new ShipmentError('ROLL_NOT_FOUND', `标签卷 #${a.roll_id} 不存在`);
      if (roll.batch_id !== batch_id) {
        throw new ShipmentError(
          'ROLL_BATCH_MISMATCH',
          `卷 ${roll.roll_code || ('#' + roll.id)} 不属于批次 ${batch.code}`
        );
      }
      if (roll.status !== 'ACTIVE') {
        throw new ShipmentError(
          'ROLL_RETIRED',
          `卷 ${roll.roll_code} 已永久停用，其标签不得再出货`,
          [roll.retired_reason]
        );
      }
      const release = roll.release_id == null ? null
        : db.prepare(
          `SELECT id, status, released_at, released_by, snapshot_allergens
             FROM releases WHERE id = ?`
        ).get(roll.release_id);
      if (!release || release.status !== 'ACTIVE') {
        throw new ShipmentError(
          'RELEASE_INACTIVE',
          `卷 ${roll.roll_code} 绑定的放行记录${release ? '已失效' : '已删除'}，不能出货`
        );
      }

      // 累计已分配数：出货明细只增不改（待评估单也持续占用其已分配数量）。
      const usedRow = db.prepare(
        'SELECT COALESCE(SUM(qty),0) AS used FROM shipment_items WHERE roll_id = ?'
      ).get(roll.id);
      const allocated = usedRow.used;
      if (allocated + a.qty > roll.applied_qty) {
        throw new ShipmentError(
          'OVER_APPLIED',
          `卷 ${roll.roll_code} 可出货（已贴用）${roll.applied_qty} 张，此前累计已分配 ${allocated} 张，` +
          `本次再分配 ${a.qty} 张后为 ${allocated + a.qty} 张，超过已贴用数；整单拒绝、不占用数量`
        );
      }
      resolved.push({ alloc: a, roll, release, allocatedBefore: allocated });
    }

    const inTxTotal = resolved.reduce((s, x) => s + x.alloc.qty, 0);
    if (inTxTotal !== ship_qty) {
      throw new ShipmentError(
        'ALLOCATION_MISMATCH',
        `各卷分配张数之和 ${inTxTotal} 与出货量 ${ship_qty} 不一致；整单拒绝`
      );
    }

    // 出货时该批所有有效卷拟印集合都等于当前推导与放行快照，取首卷集合作为整单过敏原快照。
    const allergenSet = sortedSet(JSON.parse(resolved[0].roll.allergen_set || '[]'));

    inserted.id = db.prepare(
      `INSERT INTO shipments
         (shipment_code, batch_id, batch_code, ship_qty, allergen_set,
          status, review_reason, shipped_at, shipped_by)
       VALUES ('', ?, ?, ?, ?, 'SHIPPED', '', COALESCE(?, datetime('now')), ?)`
    ).run(batch_id, batch.code, ship_qty, JSON.stringify(allergenSet),
          shipped_at || null, shipped_by).lastInsertRowid;

    const shipment_code = `SHIP-${String(inserted.id).padStart(4, '0')}`;
    db.prepare('UPDATE shipments SET shipment_code = ? WHERE id = ?')
      .run(shipment_code, inserted.id);

    // 出货单状态版本从 0 起步；转待评估、登记质量处置时各推进一次。
    db.prepare('INSERT INTO shipment_versions (shipment_id, version) VALUES (?, 0)')
      .run(inserted.id);

    const insItem = db.prepare(
      `INSERT INTO shipment_items
         (shipment_id, roll_id, roll_code, release_id, release_at, release_by,
          allergen_set, roll_revision, qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { alloc, roll, release } of resolved) {
      insItem.run(
        inserted.id, roll.id, roll.roll_code, release.id,
        release.released_at, release.released_by, roll.allergen_set,
        roll.revision, alloc.qty
      );
    }
  });
  tx();

  return getShipment(db, inserted.id);
}

// ---------- 卷停用联动：把分配过停用卷的已出货单置为“待评估” ----------
// 返回本次新转入 PENDING_REVIEW 的出货单（完整单据，含原因与明细）。
// 终态：已待评估的不重复处理、不自动恢复。
function syncPendingShipments(db) {
  const rows = db.prepare(
    `SELECT DISTINCT s.id AS shipment_id
       FROM shipments s
       JOIN shipment_items si ON si.shipment_id = s.id
       JOIN label_rolls lr ON lr.id = si.roll_id
      WHERE s.status = 'SHIPPED' AND lr.status = 'RETIRED'`
  ).all();
  if (!rows.length) return [];

  const reasonStmt = db.prepare(
    `SELECT si.roll_code, lr.retired_reason
       FROM shipment_items si
       JOIN label_rolls lr ON lr.id = si.roll_id
      WHERE si.shipment_id = ? AND lr.status = 'RETIRED'`
  );
  const upd = db.prepare(
    'UPDATE shipments SET status = ?, review_reason = ? WHERE id = ? AND status = \'SHIPPED\''
  );

  const pending = [];
  for (const { shipment_id } of rows) {
    const badRolls = reasonStmt.all(shipment_id);
    const seen = new Set();
    const parts = [];
    for (const r of badRolls) {
      if (seen.has(r.roll_code)) continue;
      seen.add(r.roll_code);
      parts.push(`卷 ${r.roll_code}：${r.retired_reason || '标签卷已永久停用'}`);
    }
    const reason = `出货所用标签卷已停用，相关已出货标签需质量评估：${parts.join('；')}`;
    const info = upd.run('PENDING_REVIEW', reason, shipment_id);
    if (info.changes) {
      // 转待评估即推进状态版本：此前查询取得的版本立即过期，处置须按最新状态重新查询。
      const { bumpVersion } = require('./evaluation');
      bumpVersion(db, shipment_id);
      pending.push(formatShipment(
        db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipment_id), db
      ));
    }
  }
  return pending;
}

// 放行删除路由专用：停卷 + 待评估在同一事务内原子完成。
function markPendingForRetirement(db) {
  return syncPendingShipments(db);
}

// ---------- 读取模型 ----------
function getShipment(db, id) {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  if (!s) return null;
  return formatShipment(s, db);
}

function getShipmentByCode(db, code) {
  const s = db.prepare('SELECT * FROM shipments WHERE shipment_code = ?').get(code);
  if (!s) return null;
  return formatShipment(s, db);
}

function listShipments(db, { batch_id = null, status = null } = {}) {
  let sql = 'SELECT * FROM shipments WHERE 1=1';
  const args = [];
  if (batch_id != null && Number.isInteger(batch_id)) {
    sql += ' AND batch_id = ?';
    args.push(batch_id);
  }
  if (status) {
    sql += ' AND status = ?';
    args.push(status);
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...args).map((s) => formatShipment(s, db));
}

function formatShipment(s, db) {
  if (!s) return null;
  const items = db
    ? db.prepare(
      `SELECT id, roll_id, roll_code, release_id, release_at, release_by,
              allergen_set, roll_revision, qty
         FROM shipment_items WHERE shipment_id = ? ORDER BY id`
    ).all(s.id).map((it) => ({
      id: it.id,
      roll_id: it.roll_id,
      roll_code: it.roll_code,
      release_id: it.release_id,
      release_at: it.release_at,
      release_by: it.release_by,
      allergens: JSON.parse(it.allergen_set || '[]'),
      roll_revision: it.roll_revision,
      qty: it.qty
    }))
    : [];
  let currentDisposition = null;
  let dispositionCount = 0;
  if (db) {
    const rows = db.prepare(
      'SELECT * FROM shipment_dispositions WHERE shipment_id = ? ORDER BY id DESC'
    ).all(s.id);
    dispositionCount = rows.length;
    if (rows.length) {
      const d = rows[0];
      currentDisposition = {
        id: d.id,
        decision: d.decision,
        decision_text: d.decision === 'CONTINUE' ? '准予继续流转' : '召回',
        decided_by: d.decided_by,
        basis: d.basis,
        life_status: d.life_status,
        active: d.life_status === 'ACTIVE',
        needs_review: d.life_status === 'STALE',
        stale_reason: d.stale_reason || '',
        decided_at: d.decided_at
      };
    }
  }
  return {
    id: s.id,
    shipment_code: s.shipment_code,
    batch_id: s.batch_id,
    batch_code: s.batch_code,
    ship_qty: s.ship_qty,
    allocated_qty: items.reduce((n, it) => n + it.qty, 0),
    allergens: JSON.parse(s.allergen_set || '[]'),
    status: s.status,
    pending_review: s.status === 'PENDING_REVIEW',
    review_reason: s.review_reason || '',
    shipped_at: s.shipped_at,
    shipped_by: s.shipped_by,
    created_at: s.created_at,
    current_disposition: currentDisposition,
    disposition_count: dispositionCount,
    items
  };
}

// ---------- 批次可出货余额 ----------
// 可出货余额 = 该批次所有“未停用卷”的 max(已贴用 - 累计已分配, 0) 之和。
// 停卷尚未分配的已贴张数因只接受 ACTIVE 卷而自然排除（不可再出货）。
function batchBalance(db, batchId) {
  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new ShipmentError('BATCH_NOT_FOUND', '批次不存在');
  const rollRows = db.prepare(
    `SELECT lr.id, lr.roll_code, lr.status, lr.print_qty, lr.applied_qty,
            lr.void_qty, lr.revision,
            COALESCE((SELECT SUM(qty) FROM shipment_items si WHERE si.roll_id = lr.id), 0)
              AS allocated_qty
       FROM label_rolls lr
      WHERE lr.batch_id = ?
      ORDER BY lr.roll_code`
  ).all(batchId);

  const rolls = rollRows.map((r) => {
    const available = r.status === 'ACTIVE'
      ? Math.max(r.applied_qty - (r.allocated_qty || 0), 0)
      : 0;
    return {
      roll_id: r.id,
      roll_code: r.roll_code,
      status: r.status,
      active: r.status === 'ACTIVE',
      print_qty: r.print_qty,
      applied_qty: r.applied_qty,
      void_qty: r.void_qty,
      allocated_qty: r.allocated_qty || 0,
      available_qty: available
    };
  });

  return {
    batch_id: batch.id,
    batch_code: batch.code,
    shippable_qty: rolls.reduce((s, r) => s + r.available_qty, 0),
    applied_qty: rolls.reduce((s, r) => s + r.applied_qty, 0),
    allocated_qty: rolls.reduce((s, r) => s + r.allocated_qty, 0),
    rolls
  };
}

function allBalances(db) {
  const batches = db.prepare('SELECT id FROM batches ORDER BY id').all();
  return batches.map((b) => batchBalance(db, b.id));
}

module.exports = {
  ShipmentError,
  createShipment,
  syncPendingShipments,
  markPendingForRetirement,
  getShipment,
  getShipmentByCode,
  listShipments,
  formatShipment,
  batchBalance,
  allBalances
};
