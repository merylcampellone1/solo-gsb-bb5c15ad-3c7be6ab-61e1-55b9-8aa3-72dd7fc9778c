'use strict';
// 过敏原标签卷。
//
// 登记（包装前）：按“现有批次 + 有效放行记录”登记一卷过敏原标签。
//   拟印过敏原集合必须与①该批次当前推导结果、②所选放行快照“完全一致”（三方一致），
//   印量为正整数；登记后返回卷号与可用张数。
//
// 核销：每卷凭“预期修订号”核销贴用与作废张数，累计不得超过印量。
//   旧修订号、负数、超量均整次拒绝（事务回滚，修订号不前进）。
//
// 永久停用：原料或加工事件变更、换线整组确认应用使集合改变，或绑定放行失效/删除时，
//   该卷永久停用（RETIRED，终态）：已贴数量标记待复核，余量不可再贴；
//   即使集合后来恢复也不自动解冻。

class LabelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LabelError';
    this.code = code;
    this.details = details || [];
  }
}

function sortedSet(list) {
  return [...new Set(list.map((a) => String(a).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}
function canonical(list) {
  return JSON.stringify(sortedSet(list));
}

function intNonNeg(v, field, { positive = false } = {}) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : parseInt(v, 10);
  if (!Number.isInteger(n)) {
    throw new LabelError('INVALID_REQUEST', `${field}必须是${positive ? '正' : '非负'}整数`);
  }
  if (positive ? n <= 0 : n < 0) {
    throw new LabelError('INVALID_REQUEST', `${field}必须${positive ? '大于 0' : '不小于 0'}`);
  }
  return n;
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// ---------- 登记一卷 ----------
function registerRoll(db, body) {
  const batch_id = parseInt(body && body.batch_id, 10);
  if (!Number.isInteger(batch_id)) throw new LabelError('INVALID_REQUEST', '请选择批次');
  const release_id = parseInt(body && body.release_id, 10);
  if (!Number.isInteger(release_id)) throw new LabelError('INVALID_REQUEST', '请选择有效放行记录');
  const print_qty = intNonNeg(body && body.print_qty, '印量', { positive: true });
  if (print_qty > 1e9) throw new LabelError('INVALID_REQUEST', '印量超出允许范围');
  const registered_by = String((body && body.registered_by) || '').trim() || '未署名';
  const registered_at = String((body && body.registered_at) || '').trim();
  if (registered_at && !TIME_RE.test(registered_at)) {
    throw new LabelError('INVALID_REQUEST', '登记时间格式应为 YYYY-MM-DDTHH:MM');
  }
  const declared = Array.isArray(body && body.allergens) ? body.allergens : null;
  if (!declared) throw new LabelError('INVALID_REQUEST', '请录入拟印过敏原集合');
  const declaredSet = sortedSet(declared);

  const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(batch_id);
  if (!batch) throw new LabelError('BATCH_NOT_FOUND', '该批次不存在');
  const out = db.prepare('SELECT allergens FROM batch_outputs WHERE batch_id = ?').get(batch_id);
  const ev = db.prepare('SELECT id FROM events WHERE batch_id = ?').get(batch_id);
  if (!out || !ev) throw new LabelError('BATCH_NOT_PRODUCED', '该批次尚无加工记录，无法登记标签卷');

  const release = db.prepare(
    'SELECT id, batch_id, status, snapshot_allergens FROM releases WHERE id = ?'
  ).get(release_id);
  if (!release) throw new LabelError('RELEASE_NOT_FOUND', '所选放行记录不存在');
  if (release.batch_id !== batch_id) {
    throw new LabelError(
      'RELEASE_BATCH_MISMATCH',
      '所选放行快照不属于该批次，请选择该批次自己的有效放行记录'
    );
  }
  if (release.status !== 'ACTIVE') {
    throw new LabelError('RELEASE_INACTIVE', '所选放行记录已失效，请按当前结果重新登记放行后再包装');
  }

  const currentSet = sortedSet(JSON.parse(out.allergens));
  const snapshotSet = sortedSet(JSON.parse(release.snapshot_allergens));
  const declaredJson = JSON.stringify(declaredSet);
  if (declaredJson !== JSON.stringify(currentSet) || declaredJson !== JSON.stringify(snapshotSet)) {
    throw new LabelError('ALLERGENS_MISMATCH',
      '拟印过敏原集合与当前批次推导结果或所选放行快照不完全一致，拒绝登记',
      [
        `拟印集合：${declaredSet.join('、') || '（空）'}`,
        `当前批次推导：${currentSet.join('、') || '（空）'}`,
        `放行快照：${snapshotSet.join('、') || '（空）'}`
      ]);
  }

  let rollId;
  const tx = db.transaction(() => {
    rollId = db.prepare(
      `INSERT INTO label_rolls
         (roll_code, batch_id, release_id, print_qty, applied_qty, void_qty,
          revision, allergen_set, registered_at, registered_by, status, retired_reason)
       VALUES ('', ?, ?, ?, 0, 0, 0, ?, COALESCE(?, datetime('now')), ?, 'ACTIVE', '')`
    ).run(batch_id, release_id, print_qty, declaredJson, registered_at || null, registered_by)
      .lastInsertRowid;
    const roll_code = `LABEL-${String(rollId).padStart(4, '0')}`;
    db.prepare('UPDATE label_rolls SET roll_code = ? WHERE id = ?').run(roll_code, rollId);
  });
  tx();

  return formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(rollId));
}

// ---------- 核销贴用 / 作废 ----------
function consumeRoll(db, id, body) {
  const roll = db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id);
  if (!roll) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
  if (roll.status !== 'ACTIVE') {
    throw new LabelError(
      'ROLL_RETIRED',
      `该卷已永久停用（${roll.retired_reason || '见停用原因'}），余量不可再贴；已贴数量待复核`,
      [roll.retired_reason]
    );
  }
  const expected_revision = parseInt(body && body.expected_revision, 10);
  if (!Number.isInteger(expected_revision) || expected_revision < 0) {
    throw new LabelError('INVALID_REQUEST', '请提供预期修订号（非负整数）');
  }
  // applied / voided 为文档用语；兼容 used/void_qty 别名。
  const applied = intNonNeg(body && body.applied != null ? body.applied : body && body.used, '贴用张数');
  const voided = intNonNeg(body && body.voided != null ? body.voided : body && body.void_qty, '作废张数');
  if (applied === 0 && voided === 0) {
    throw new LabelError('INVALID_REQUEST', '贴用与作废张数均为 0，无内容可核销');
  }
  const used_by = String((body && body.used_by) || (body && body.operator) || '').trim() || '未署名';
  const used_at = String((body && body.used_at) || '').trim();
  if (used_at && !TIME_RE.test(used_at)) {
    throw new LabelError('INVALID_REQUEST', '核销时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let result;
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT revision, applied_qty, void_qty, print_qty FROM label_rolls WHERE id = ?').get(id);
    if (!cur) throw new LabelError('ROLL_NOT_FOUND', '标签卷不存在');
    if (cur.revision !== expected_revision) {
      throw new LabelError(
        'REVISION_MISMATCH',
        `修订号已过期：卷当前修订号为 ${cur.revision}，提交的预期修订号为 ${expected_revision}；整次拒绝`
      );
    }
    const nextApplied = cur.applied_qty + applied;
    const nextVoid = cur.void_qty + voided;
    if (nextApplied + nextVoid > cur.print_qty) {
      throw new LabelError(
        'OVER_LIMIT',
        `超过印量：印量 ${cur.print_qty}，已贴 ${cur.applied_qty}、已作废 ${cur.void_qty}，` +
        `本次申请贴用 ${applied}、作废 ${voided}，核销后累计 ${nextApplied + nextVoid} 超过印量；整次拒绝`
      );
    }
    db.prepare(
      `INSERT INTO label_roll_usages (roll_id, used_at, applied_qty, void_qty, expected_revision, used_by)
       VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)`
    ).run(id, used_at || null, applied, voided, expected_revision, used_by);
    db.prepare(
      'UPDATE label_rolls SET applied_qty = ?, void_qty = ?, revision = revision + 1 WHERE id = ?'
    ).run(nextApplied, nextVoid, id);
    result = formatRoll(db.prepare('SELECT * FROM label_rolls WHERE id = ?').get(id));
  });
  tx();
  return result;
}

// ---------- 终态停用 ----------
function deactivateRolls(db, ids, reason) {
  const list = Array.isArray(ids) ? ids : [ids];
  const stmt = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ?
      WHERE id = ? AND status = 'ACTIVE'`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const id of list) count += stmt.run(reason, id).changes;
  });
  tx();
  return count;
}

// 放行被删除：其名下所有有效卷永久停用（放行已不存在，无法再保持一致）。
function deactivateForReleaseDeletion(db, releaseId) {
  const release = db.prepare(
    `SELECT r.id, r.batch_id, b.code AS batch_code, r.released_at
       FROM releases r LEFT JOIN batches b ON b.id = r.batch_id WHERE r.id = ?`
  ).get(releaseId);
  const reason = `绑定的放行记录已删除（批次 ${release ? release.batch_code || '#' + release.batch_id : '?'}，` +
    `放行时间 ${release ? release.released_at : '?'}），标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE release_id = ? AND status = 'ACTIVE'"
  ).all(releaseId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 加工事件删除致批次连带删除的兜底：该批次剩余有效卷永久停用。
function deactivateForBatchDeletion(db, batchId, batchCode) {
  const reason = `批次 ${batchCode || '#' + batchId} 的加工事件已删除，标签卷永久停用`;
  const rolls = db.prepare(
    "SELECT id, roll_code FROM label_rolls WHERE batch_id = ? AND status = 'ACTIVE'"
  ).all(batchId);
  const count = deactivateRolls(db, rolls.map((r) => r.id), reason);
  return { count, reason, rolls };
}

// 重算后核对：对所有仍有效的卷检查“绑定放行 / 批次 / 集合”是否仍一致。
// 只在重算事务内调用；停用为终态，不做任何“解冻”。
function syncRollsAfterRecompute(db, batchResult) {
  const rollRows = db.prepare(
    `SELECT lr.id, lr.roll_code, lr.batch_id, lr.release_id, lr.allergen_set,
            b.code AS batch_code
       FROM label_rolls lr LEFT JOIN batches b ON b.id = lr.batch_id
      WHERE lr.status = 'ACTIVE'`
  ).all();
  const upd = db.prepare(
    `UPDATE label_rolls SET status = 'RETIRED', retired_reason = ? WHERE id = ?`
  );
  const retired = [];
  for (const roll of rollRows) {
    let reason = null;

    if (roll.release_id == null) {
      reason = '绑定的放行记录已删除，标签卷永久停用';
    } else {
      const release = db.prepare('SELECT status, invalid_reason FROM releases WHERE id = ?')
        .get(roll.release_id);
      if (!release) {
        reason = '绑定的放行记录已删除，标签卷永久停用';
      } else if (release.status === 'INVALIDATED') {
        reason = `绑定放行已失效：${release.invalid_reason || '放行快照与当前推导结果不一致'}；标签卷永久停用`;
      }
    }

    if (!reason) {
      const result = batchResult.get(roll.batch_id);
      if (!result) {
        reason = '该批次的加工事件已不存在，无法重新推导过敏原，标签卷永久停用';
      } else if (canonical([...result.keys()]) !== roll.allergen_set) {
        const oldSet = JSON.parse(roll.allergen_set);
        const newSet = [...result.keys()];
        const added = newSet.filter((a) => !oldSet.includes(a));
        const removed = oldSet.filter((a) => !newSet.includes(a));
        const parts = [];
        if (added.length) parts.push(`新增：${added.join('、')}`);
        if (removed.length) parts.push(`移除：${removed.join('、')}`);
        reason = `批次过敏原集合已改变（${parts.join('；') || '集合内容变化'}），与拟印集合不一致，标签卷永久停用`;
      }
    }

    if (reason) {
      upd.run(reason, roll.id);
      retired.push({
        id: roll.id, roll_code: roll.roll_code,
        batch_code: roll.batch_code || null, reason,
        applied_pending_review: db.prepare(
          'SELECT applied_qty FROM label_rolls WHERE id = ?'
        ).get(roll.id).applied_qty
      });
    }
  }
  return retired;
}

// ---------- 读取模型 ----------
function formatRoll(r) {
  if (!r) return null;
  const applied = r.applied_qty || 0;
  const voided = r.void_qty || 0;
  const print = r.print_qty || 0;
  return {
    id: r.id,
    roll_code: r.roll_code,
    batch_id: r.batch_id,
    release_id: r.release_id,
    allergens: JSON.parse(r.allergen_set || '[]'),
    print_qty: print,
    applied_qty: applied,
    void_qty: voided,
    remaining_qty: print - applied - voided,
    revision: r.revision,
    registered_at: r.registered_at,
    registered_by: r.registered_by,
    status: r.status,
    active: r.status === 'ACTIVE',
    retired_reason: r.retired_reason || '',
    applied_pending_review: r.status === 'RETIRED' ? applied : 0
  };
}

module.exports = {
  LabelError,
  registerRoll,
  consumeRoll,
  deactivateForReleaseDeletion,
  deactivateForBatchDeletion,
  syncRollsAfterRecompute,
  formatRoll
};
