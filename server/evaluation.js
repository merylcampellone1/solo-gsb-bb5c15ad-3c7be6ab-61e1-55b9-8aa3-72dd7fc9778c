'use strict';
// 出货质量处置（整单）：对“待评估（PENDING_REVIEW）”出货单登记整单结论。
//
//   GET  /api/shipments/:idOrCode/evaluation  查询评估视图：
//        出货当时的过敏原、逐卷分配与放行快照；当前批次过敏原、当前有效放行、
//        所用各卷当前状态与停用原因；以及“准予继续流转”是否满足的条件判定，
//        并签发本次查询的状态版本（签名令牌，30 分钟有效；服务重启后旧版本作废）。
//
//   POST /api/shipments/:idOrCode/dispositions  提交整单处置：
//        body { decision:'CONTINUE'|'RECALL', decided_by, basis, version, decided_at? }
//        - 仅待评估单可提交；
//        - CONTINUE（准予继续流转）仅在「批次仍存在且可推导 + 当前有有效放行 +
//          出货快照覆盖当前过敏原」三条同时成立时允许，否则只能 RECALL（召回）；
//        - 必须携带查询取得的 version；事务内重新核对签名、TTL、最新状态版本与上下文指纹，
//          过期/被并发改动则 409 VERSION_EXPIRED 拒绝且不产生任何记录；
//        - 同一单已存在有效（ACTIVE）结论时拒绝重复提交（旧版本不得覆盖新结论）。
//
// 记录只增不改：shipment_dispositions 行只插入，从不 UPDATE 结论内容。
//   此后批次过敏原、有效放行或所用卷停用信息变化（重算 / 放行新增或删除）时，
//   syncStaleDispositions 把仍为 ACTIVE 的旧结论标为 STALE（需重新评估），
//   旧结论、依据、操作人原样保留；不自动恢复、不自动生效，出货单原状态与数量占用也不变。

const crypto = require('crypto');
const shipments = require('./shipments');

const VERSION_TTL_MS = 30 * 60 * 1000; // 查询版本有效期 30 分钟
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 进程级随机密钥：重启后旧查询版本自然失效。
const SIGN_SECRET = crypto.randomBytes(32);

class EvaluationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
    this.details = details || [];
  }
}

function sortZh(arr) {
  return [...new Set(arr.map((a) => String(a)))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

// 稳定序列化（用于上下文指纹）。
function canonicalString(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalString).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalString(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---------- 状态版本（每单单调递增的整数 + 无状态签名令牌） ----------
function currentVersion(db, shipmentId) {
  const row = db.prepare(
    'SELECT version FROM shipment_versions WHERE shipment_id = ?'
  ).get(shipmentId);
  return row ? row.version : 0;
}

function bumpVersion(db, shipmentId) {
  db.prepare(
    `INSERT INTO shipment_versions (shipment_id, version) VALUES (?, 1)
     ON CONFLICT(shipment_id) DO UPDATE SET version = version + 1`
  ).run(shipmentId);
  return currentVersion(db, shipmentId);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', SIGN_SECRET).update(payloadB64).digest());
}
function issueVersion(db, shipmentId, contextHash) {
  const ver = currentVersion(db, shipmentId);
  const payloadB64 = b64url(JSON.stringify({ sid: shipmentId, ver, ctx: contextHash, ts: Date.now() }));
  return {
    version: `${payloadB64}.${sign(payloadB64)}`,
    status_version: ver,
    context_version: contextHash.slice(0, 12),
    version_expires_in_ms: VERSION_TTL_MS
  };
}
function parseVersion(version, expectedShipmentId) {
  if (typeof version !== 'string' || !version.includes('.')) {
    throw new EvaluationError('VERSION_INVALID', '状态版本格式不正确，请重新查询获取版本');
  }
  const dot = version.indexOf('.');
  const payloadB64 = version.slice(0, dot);
  const sig = version.slice(dot + 1);
  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new EvaluationError('VERSION_INVALID', '状态版本签名不合法，请重新查询获取版本');
  }
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
  } catch (_) {
    throw new EvaluationError('VERSION_INVALID', '状态版本内容不合法，请重新查询获取版本');
  }
  if (!payload || typeof payload.sid !== 'number' ||
      typeof payload.ver !== 'number' || typeof payload.ctx !== 'string') {
    throw new EvaluationError('VERSION_INVALID', '状态版本内容不合法，请重新查询获取版本');
  }
  if (expectedShipmentId != null && payload.sid !== expectedShipmentId) {
    throw new EvaluationError('VERSION_INVALID', '状态版本与本出货单不匹配，请重新查询获取版本');
  }
  if (Date.now() - payload.ts > VERSION_TTL_MS) {
    throw new EvaluationError('VERSION_EXPIRED', '查询取得的状态版本已过期，请重新查询后再提交');
  }
  return payload;
}

// ---------- 评估上下文：出货快照 vs 当前批次/放行/所用卷 ----------
function buildContext(db, s) {
  const snapshotAllergens = sortZh(JSON.parse(s.allergen_set || '[]'));
  const ctx = {
    shipment_id: s.id,
    batch_id: s.batch_id,
    batch_exists: false,
    batch_produced: false,
    batch_code: null,
    batch_allergens: [],
    snapshot_allergens: snapshotAllergens,
    active_releases: [],
    used_rolls: [],
    uncovered_allergens: [],
    snapshot_covers_current: false,
    has_active_release: false,
    can_continue: false
  };

  if (s.batch_id != null) {
    const batch = db.prepare('SELECT id, code FROM batches WHERE id = ?').get(s.batch_id);
    if (batch) {
      ctx.batch_exists = true;
      ctx.batch_code = batch.code;
      const out = db.prepare(
        'SELECT allergens FROM batch_outputs WHERE batch_id = ?'
      ).get(batch.id);
      if (out) {
        ctx.batch_produced = true;
        ctx.batch_allergens = sortZh(JSON.parse(out.allergens));
      }
      ctx.active_releases = db.prepare(
        `SELECT id, released_at, released_by, snapshot_allergens
           FROM releases WHERE batch_id = ? AND status = 'ACTIVE' ORDER BY id`
      ).all(batch.id).map((r) => ({
        id: r.id,
        released_at: r.released_at,
        released_by: r.released_by,
        snapshot_allergens: sortZh(JSON.parse(r.snapshot_allergens || '[]'))
      }));
    }
  }

  const rollIds = db.prepare(
    'SELECT DISTINCT roll_id FROM shipment_items WHERE shipment_id = ?'
  ).all(s.id).map((r) => r.roll_id);
  for (const rollId of rollIds) {
    const roll = db.prepare(
      'SELECT id, roll_code, status, retired_reason, release_id, allergen_set FROM label_rolls WHERE id = ?'
    ).get(rollId);
    if (!roll) {
      ctx.used_rolls.push({ roll_id: rollId, roll_code: null, missing: true });
      continue;
    }
    let release = null;
    if (roll.release_id != null) {
      release = db.prepare(
        'SELECT id, status, released_at, released_by FROM releases WHERE id = ?'
      ).get(roll.release_id);
    }
    ctx.used_rolls.push({
      roll_id: roll.id,
      roll_code: roll.roll_code,
      status: roll.status,
      retired: roll.status === 'RETIRED',
      retired_reason: roll.retired_reason || '',
      release_id: roll.release_id,
      release_exists: !!release,
      release_active: !!(release && release.status === 'ACTIVE'),
      release_at: release ? release.released_at : null,
      release_by: release ? release.released_by : ''
    });
  }

  // 出货快照覆盖当前过敏原：当前集合是出货快照集合的子集（出货时印刷的声明更宽也视为覆盖）。
  ctx.uncovered_allergens = ctx.batch_produced
    ? ctx.batch_allergens.filter((a) => !snapshotAllergens.includes(a))
    : [];
  ctx.snapshot_covers_current = ctx.batch_produced && ctx.uncovered_allergens.length === 0;
  ctx.has_active_release = ctx.active_releases.length > 0;
  ctx.can_continue = ctx.batch_exists && ctx.batch_produced &&
    ctx.has_active_release && ctx.snapshot_covers_current;
  return ctx;
}

// 仅纳入“准予/召回结论是否仍站得住”的要素；展示性字段不放进来。
function contextHash(ctx) {
  const payload = {
    batch_exists: ctx.batch_exists,
    batch_produced: ctx.batch_produced,
    batch_id: ctx.batch_id,
    batch_allergens: ctx.batch_allergens,
    snapshot_allergens: ctx.snapshot_allergens,
    active_release_ids: ctx.active_releases.map((r) => r.id).sort((a, b) => a - b),
    used_rolls: ctx.used_rolls.map((r) => ({
      roll_id: r.roll_id,
      missing: !!r.missing,
      status: r.status || null,
      retired_reason: r.retired_reason || '',
      release_id: r.release_id == null ? null : r.release_id,
      release_exists: !!r.release_exists,
      release_active: !!r.release_active
    })).sort((a, b) => a.roll_id - b.roll_id)
  };
  return crypto.createHash('sha256').update(canonicalString(payload)).digest('hex');
}

// ---------- 条件不满足的中文原因 ----------
function continueBlockers(ctx) {
  const blockers = [];
  if (!ctx.batch_exists) {
    blockers.push('批次已不存在（加工事件已删除），不允许准予继续流转，只能召回');
  } else if (!ctx.batch_produced) {
    blockers.push('该批次已无法重新推导过敏原（加工事件不存在），不允许准予继续流转，只能召回');
  }
  if (ctx.batch_exists && ctx.batch_produced && ctx.uncovered_allergens.length) {
    blockers.push(
      `出货快照未覆盖当前批次过敏原（当前新增未声明：${ctx.uncovered_allergens.join('、')}），` +
      '不允许准予继续流转，只能召回'
    );
  }
  if (ctx.batch_exists && !ctx.has_active_release) {
    blockers.push('当前没有有效放行记录，不允许准予继续流转，只能召回');
  }
  return blockers;
}

// ---------- 读取模型 ----------
function resolveShipment(db, idOrCode) {
  const key = String(idOrCode == null ? '' : idOrCode).trim();
  if (/^\d+$/.test(key)) return shipments.getShipment(db, parseInt(key, 10));
  return shipments.getShipmentByCode(db, key);
}

function formatDisposition(row) {
  return {
    id: row.id,
    shipment_id: row.shipment_id,
    decision: row.decision,
    decision_text: row.decision === 'CONTINUE' ? '准予继续流转' : '召回',
    decided_by: row.decided_by,
    basis: row.basis,
    expected_version: row.expected_version,
    status_version: row.status_version,
    life_status: row.life_status,
    active: row.life_status === 'ACTIVE',
    needs_review: row.life_status === 'STALE',
    stale_reason: row.stale_reason || '',
    decided_at: row.decided_at,
    created_at: row.created_at
  };
}

function listDispositions(db, shipmentId) {
  return db.prepare(
    'SELECT * FROM shipment_dispositions WHERE shipment_id = ? ORDER BY id'
  ).all(shipmentId).map(formatDisposition);
}

// 组装评估视图（含签名状态版本）。
function getEvaluation(db, idOrCode) {
  const s = resolveShipment(db, idOrCode);
  if (!s) throw new EvaluationError('SHIPMENT_NOT_FOUND', '出货单不存在');
  const row = db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
  const ctx = buildContext(db, row);
  const hash = contextHash(ctx);
  const token = issueVersion(db, s.id, hash);
  const history = listDispositions(db, s.id);
  const current = history.length ? history[history.length - 1] : null;

  return {
    shipment: s,
    review: {
      reviewable: row.status === 'PENDING_REVIEW',
      status: row.status,
      pending_review: row.status === 'PENDING_REVIEW',
      review_reason: row.review_reason || ''
    },
    // 出货当时：过敏原、逐卷分配与放行快照（shipment.items 已含逐卷快照）。
    shipment_snapshot: {
      allergens: ctx.snapshot_allergens,
      shipped_at: row.shipped_at,
      shipped_by: row.shipped_by,
      items: s.items
    },
    // 当前批次过敏原、有效放行、所用卷停用原因。
    current_state: {
      batch_exists: ctx.batch_exists,
      batch_id: ctx.batch_id,
      batch_code: ctx.batch_code,
      batch_allergens: ctx.batch_allergens,
      active_releases: ctx.active_releases,
      used_rolls: ctx.used_rolls
    },
    conditions: {
      batch_exists: ctx.batch_exists && ctx.batch_produced,
      has_active_release: ctx.has_active_release,
      snapshot_covers_current: ctx.snapshot_covers_current,
      uncovered_allergens: ctx.uncovered_allergens,
      can_continue: ctx.can_continue,
      only_recall: !ctx.can_continue,
      blockers: continueBlockers(ctx)
    },
    // 查询时取得的状态版本：提交时原样回传。
    status_version: token.status_version,
    context_version: token.context_version,
    version: token.version,
    version_expires_in_ms: token.version_expires_in_ms,
    current_disposition: current,
    current_effective: !!(current && current.active),
    history
  };
}

// 供列表 / 整页状态附加的“当前结论”摘要（不签发版本令牌）。
function currentDispositionMap(db) {
  const rows = db.prepare(
    `SELECT d.* FROM shipment_dispositions d
       JOIN (SELECT shipment_id, MAX(id) AS max_id FROM shipment_dispositions GROUP BY shipment_id) m
         ON m.max_id = d.id`
  ).all();
  const map = new Map();
  for (const r of rows) map.set(r.shipment_id, formatDisposition(r));
  return map;
}

// ---------- 提交整单处置 ----------
function submitDisposition(db, idOrCode, body) {
  body = body || {};
  // 先验版本（签名/格式/TTL 与出货单归属）：版本本身不合法时直接拒绝，不产生任何写入。
  const payload = parseVersion(body.version, null);

  const s = resolveShipment(db, idOrCode);
  if (!s) throw new EvaluationError('SHIPMENT_NOT_FOUND', '出货单不存在');
  if (payload.sid !== s.id) {
    throw new EvaluationError('VERSION_INVALID', '状态版本与本出货单不匹配，请重新查询获取版本');
  }

  const decision = String(body.decision || '').toUpperCase();
  if (decision !== 'CONTINUE' && decision !== 'RECALL') {
    throw new EvaluationError('INVALID_REQUEST', '处置结论必须是 CONTINUE（准予继续流转）或 RECALL（召回）');
  }
  const decided_by = String(body.decided_by || '').trim();
  if (!decided_by) throw new EvaluationError('INVALID_REQUEST', '请录入提交操作人');
  const basis = String(body.basis || '').trim();
  if (!basis) throw new EvaluationError('INVALID_REQUEST', '请录入处置依据');
  const decided_at = String(body.decided_at || '').trim();
  if (decided_at && !TIME_RE.test(decided_at)) {
    throw new EvaluationError('INVALID_REQUEST', '处置时间格式应为 YYYY-MM-DDTHH:MM');
  }

  let insertedId = null;
  const tx = db.transaction(() => {
    // ---- 事务内权威复核：最新状态版本 + 最新上下文指纹 ----
    const curVersion = currentVersion(db, s.id);
    if (payload.ver !== curVersion) {
      throw new EvaluationError(
        'VERSION_EXPIRED',
        `状态版本已过期：查询时版本为 ${payload.ver}，当前最新版本为 ${curVersion}；` +
        '请重新查询获取最新版本后再提交（本次不产生记录）'
      );
    }
    const row = db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id);
    if (row.status !== 'PENDING_REVIEW') {
      throw new EvaluationError(
        'SHIPMENT_NOT_REVIEWABLE',
        '该出货单当前不是待评估状态，不能登记质量处置结论'
      );
    }
    const ctx = buildContext(db, row);
    const hash = contextHash(ctx);
    if (hash !== payload.ctx) {
      throw new EvaluationError(
        'VERSION_EXPIRED',
        '查询后批次过敏原、有效放行或所用卷停用信息已变化，该状态版本已过期；' +
        '请重新查询获取最新版本后再提交（本次不产生记录）'
      );
    }

    // 记录只增不改：已有有效结论时一律拒绝（重复用旧版本也不得覆盖新结论）。
    const latest = db.prepare(
      'SELECT id, decision, life_status FROM shipment_dispositions WHERE shipment_id = ? ORDER BY id DESC LIMIT 1'
    ).get(s.id);
    if (latest && latest.life_status === 'ACTIVE') {
      const text = latest.decision === 'CONTINUE' ? '准予继续流转' : '召回';
      throw new EvaluationError(
        'DISPOSITION_EXISTS',
        `该出货单已存在有效的质量处置结论（${text}，记录 #${latest.id}）；` +
        '处置记录只增不改，不能重复提交覆盖既有结论'
      );
    }

    // 准予继续流转的三条硬条件；不满足只能召回。
    if (decision === 'CONTINUE' && !ctx.can_continue) {
      throw new EvaluationError(
        'CONTINUE_NOT_ALLOWED',
        '当前不满足“准予继续流转”的条件，只能登记召回（RECALL）',
        continueBlockers(ctx)
      );
    }

    const snapshotForHistory = {
      batch_exists: ctx.batch_exists,
      batch_produced: ctx.batch_produced,
      batch_code: ctx.batch_code,
      batch_allergens: ctx.batch_allergens,
      snapshot_allergens: ctx.snapshot_allergens,
      active_release_ids: ctx.active_releases.map((r) => r.id),
      used_rolls: ctx.used_rolls.map((r) => ({
        roll_id: r.roll_id, roll_code: r.roll_code, status: r.status,
        retired_reason: r.retired_reason, release_id: r.release_id,
        release_exists: r.release_exists, release_active: r.release_active
      }))
    };

    insertedId = db.prepare(
      `INSERT INTO shipment_dispositions
         (shipment_id, decision, decided_by, basis, expected_version,
          context_hash, context_snapshot, status_version, life_status, stale_reason, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE', '', COALESCE(?, datetime('now')))`
    ).run(s.id, decision, decided_by, basis, payload.ver,
          hash, JSON.stringify(snapshotForHistory), decided_at || null).lastInsertRowid;

    // 处置落账即推进该单状态版本（旧版本立即作废，不能再用）。
    const newVersion = bumpVersion(db, s.id);
    db.prepare('UPDATE shipment_dispositions SET status_version = ? WHERE id = ?')
      .run(newVersion, insertedId);
  });
  tx();

  return {
    ok: true,
    disposition: formatDisposition(
      db.prepare('SELECT * FROM shipment_dispositions WHERE id = ?').get(insertedId)
    ),
    evaluation: getEvaluation(db, s.id)
  };
}

// ---------- 旧结论标“需重新评估”（重算 / 放行新增或删除后调用，同一事务内） ----------
function diffStaleReason(prev, ctx) {
  const reasons = [];
  if (!ctx.batch_exists) {
    reasons.push('批次已不存在（加工事件已删除）');
  } else if (!ctx.batch_produced) {
    reasons.push('该批次已无法重新推导过敏原（加工事件不存在）');
  } else {
    const prevA = prev.batch_allergens || [];
    const curA = ctx.batch_allergens;
    const added = curA.filter((a) => !prevA.includes(a));
    const removed = prevA.filter((a) => !curA.includes(a));
    const parts = [];
    if (added.length) parts.push(`新增：${added.join('、')}`);
    if (removed.length) parts.push(`移除：${removed.join('、')}`);
    if (parts.length) reasons.push(`批次过敏原集合已变化（${parts.join('；')}）`);
  }

  const prevRel = new Set(prev.active_release_ids || []);
  const curRel = new Set(ctx.active_releases.map((r) => r.id));
  const relAdded = [...curRel].filter((x) => !prevRel.has(x));
  const relGone = [...prevRel].filter((x) => !curRel.has(x));
  if (relAdded.length || relGone.length) {
    const pr = [];
    if (relAdded.length) pr.push(`新增有效放行 #${relAdded.join('、#')}`);
    if (relGone.length) pr.push(`原有效放行 #${relGone.join('、#')} 已失效或删除`);
    if (!curRel.size) pr.push('当前已无有效放行');
    reasons.push(`有效放行发生变化（${pr.join('；')}）`);
  }

  const prevRolls = new Map((prev.used_rolls || []).map((r) => [r.roll_id, r]));
  for (const cur of ctx.used_rolls) {
    const before = prevRolls.get(cur.roll_id);
    if (!before) {
      reasons.push(`所用卷 ${cur.roll_code || ('#' + cur.roll_id)} 状态发生变化`);
      continue;
    }
    const becameRetired = before.status === 'ACTIVE' && cur.status === 'RETIRED';
    const relChanged = before.release_active !== cur.release_active ||
      before.release_exists !== cur.release_exists;
    if (becameRetired) {
      reasons.push(`所用卷 ${cur.roll_code} 已停用：${cur.retired_reason || '标签卷已永久停用'}`);
    } else if (cur.status === 'RETIRED' && before.retired_reason !== cur.retired_reason) {
      reasons.push(`所用卷 ${cur.roll_code} 停用原因已更新：${cur.retired_reason}`);
    } else if (relChanged) {
      reasons.push(
        `所用卷 ${cur.roll_code} 绑定放行状态变化（${cur.release_active ? '恢复有效' : '已失效或删除'}）`
      );
    }
  }

  return reasons.length ? reasons.join('；') : '评估所依据的状态已变化，原结论需重新评估';
}

// 检查所有仍 ACTIVE 的处置结论；上下文指纹变化者标记 STALE（只改生命周期标记，结论内容不动）。
// 返回本次新标 STALE 的处置列表。STALE 为终态，不自动恢复、不自动生效。
function syncStaleDispositions(db) {
  const rows = db.prepare(
    'SELECT * FROM shipment_dispositions WHERE life_status = \'ACTIVE\''
  ).all();
  if (!rows.length) return [];

  const upd = db.prepare(
    'UPDATE shipment_dispositions SET life_status = \'STALE\', stale_reason = ? WHERE id = ?'
  );
  const stale = [];
  for (const d of rows) {
    const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(d.shipment_id);
    if (!s) continue; // 出货单只增不删，正常不会发生；不改动处置记录。
    const ctx = buildContext(db, s);
    const hash = contextHash(ctx);
    if (hash === d.context_hash) continue;

    let prev = {};
    try { prev = JSON.parse(d.context_snapshot || '{}'); } catch (_) { prev = {}; }
    const reason = diffStaleReason(prev, ctx);
    upd.run(reason, d.id);
    stale.push({
      disposition_id: d.id,
      shipment_id: d.shipment_id,
      shipment_code: s.shipment_code,
      decision: d.decision,
      decision_text: d.decision === 'CONTINUE' ? '准予继续流转' : '召回',
      reason
    });
  }
  return stale;
}

module.exports = {
  EvaluationError,
  buildContext,
  contextHash,
  currentVersion,
  bumpVersion,
  getEvaluation,
  currentDispositionMap,
  submitDisposition,
  syncStaleDispositions,
  listDispositions,
  formatDisposition
};
