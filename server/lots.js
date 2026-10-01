'use strict';
// 原料供应批号档案。
//
// 每次加工的原料输入可记录所属供应批号（material_lot_id）；同一原料在一次加工中
// 允许使用多个批号（多条投料行）。批号只在其所属原料下命名，批号不存在或与原料
// 不匹配的写入/查询一律明确拒绝。
//
// status='FLAGGED' 仅表示“供应商通报该批号异常”的留痕标记，供质检发起追溯查询；
// 追溯与本模块均为查询/登记性质，不自动改变批次放行、标签卷、出货单与处置结论。

class LotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LotError';
    this.code = code;
    this.details = details || [];
  }
}

function createLot(db, body) {
  body = body || {};
  const material_id = parseInt(body.material_id, 10);
  if (!Number.isInteger(material_id)) throw new LotError('INVALID_REQUEST', '请选择原料 material_id');
  const material = db.prepare('SELECT id, code, name FROM materials WHERE id = ?').get(material_id);
  if (!material) throw new LotError('MATERIAL_NOT_FOUND', `原料 #${material_id} 不存在`);

  const lot_code = String(body.lot_code || '').trim();
  if (!lot_code) throw new LotError('INVALID_REQUEST', '供应批号 lot_code 不能为空');
  const supplier = String(body.supplier || '').trim();
  const note = String(body.note || '').trim();
  const status = body.status ? String(body.status).toUpperCase() : 'ACTIVE';
  if (status !== 'ACTIVE' && status !== 'FLAGGED') {
    throw new LotError('INVALID_REQUEST', '批号状态仅支持 ACTIVE 或 FLAGGED');
  }
  const flagged_reason = status === 'FLAGGED' ? String(body.flagged_reason || '').trim() : '';

  try {
    const info = db.prepare(
      `INSERT INTO material_lots (material_id, lot_code, supplier, note, status, flagged_reason)
       VALUES (?,?,?,?,?,?)`
    ).run(material_id, lot_code, supplier, note, status, flagged_reason);
    return getLot(db, info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new LotError(
        'LOT_CODE_CONFLICT',
        `原料 ${material.code}（${material.name}）下供应批号 "${lot_code}" 已存在`,
        [`material_id=${material_id}, lot_code=${lot_code}`]
      );
    }
    throw err;
  }
}

function getLot(db, id) {
  const row = db.prepare(
    `SELECT l.id, l.material_id, l.lot_code, l.supplier, l.note,
            l.status, l.flagged_reason, l.created_at,
            m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id
      WHERE l.id = ?`
  ).get(id);
  return row ? formatLot(row) : null;
}

function formatLot(row) {
  return {
    id: row.id,
    material_id: row.material_id,
    material_code: row.material_code,
    material_name: row.material_name,
    lot_code: row.lot_code,
    supplier: row.supplier || '',
    note: row.note || '',
    status: row.status,
    flagged: row.status === 'FLAGGED',
    flagged_reason: row.flagged_reason || '',
    created_at: row.created_at
  };
}

function listLots(db, { material_id = null } = {}) {
  let sql =
    `SELECT l.id, l.material_id, l.lot_code, l.supplier, l.note,
            l.status, l.flagged_reason, l.created_at,
            m.code AS material_code, m.name AS material_name
       FROM material_lots l JOIN materials m ON m.id = l.material_id`;
  const args = [];
  if (material_id != null) {
    sql += ' WHERE l.material_id = ?';
    args.push(material_id);
  }
  sql += ' ORDER BY m.code, l.lot_code, l.id';
  return db.prepare(sql).all(...args).map(formatLot);
}

// 供应商通报异常：置 FLAGGED（仅标记留痕，不自动改变任何放行/卷/出货/处置结论）。
function flagLot(db, id, body) {
  body = body || {};
  const lot = db.prepare('SELECT id FROM material_lots WHERE id = ?').get(id);
  if (!lot) throw new LotError('LOT_NOT_FOUND', `供应批号 #${id} 不存在`);
  const reason = String(body.flagged_reason || '').trim() ||
    String(body.reason || '').trim();
  db.prepare(
    `UPDATE material_lots
        SET status = 'FLAGGED', flagged_reason = ?
      WHERE id = ?`
  ).run(reason, id);
  return getLot(db, id);
}

// 解除异常标记（回到 ACTIVE；追溯结果本身从不落库，任何时刻按最新时间线重新计算）。
function unflagLot(db, id, body) {
  body = body || {};
  const lot = db.prepare('SELECT id FROM material_lots WHERE id = ?').get(id);
  if (!lot) throw new LotError('LOT_NOT_FOUND', `供应批号 #${id} 不存在`);
  db.prepare(
    `UPDATE material_lots SET status = 'ACTIVE', flagged_reason = '' WHERE id = ?`
  ).run(id);
  return getLot(db, id);
}

// 删除批号：已被投料记录引用的批号不允许删除（保证追溯证据完整），明确拒绝。
function deleteLot(db, id) {
  const lot = getLot(db, id);
  if (!lot) throw new LotError('LOT_NOT_FOUND', `供应批号 #${id} 不存在`);
  const used = db.prepare(
    'SELECT COUNT(*) AS c FROM process_inputs WHERE material_lot_id = ?'
  ).get(id).c;
  if (used > 0) {
    throw new LotError(
      'LOT_IN_USE',
      `供应批号 ${lot.lot_code}（${lot.material_code}）已有 ${used} 条投料记录引用，不能删除；` +
      '如供应商通报异常，请将其标记为 FLAGGED 后发起批号追溯'
    );
  }
  db.prepare('DELETE FROM material_lots WHERE id = ?').run(id);
  return { ok: true, id };
}

// ---------- 投料解析（事件写入 / 整组换线共用） ----------
// 把 { material_id, lot_id?, lot_code? } 数组解析为
// { material_id, material_lot_id }（未知批号 material_lot_id=null）。
// 不合法（批号不存在、批号与原料不匹配）抛 LotError，由调用方在事务外拒绝。
function resolveMaterialInputs(db, rawInputs) {
  const lotById = new Map();
  const lotByCode = new Map(); // `${material_id}|${lot_code}` -> row
  db.prepare(
    `SELECT id, material_id, lot_code FROM material_lots`
  ).all().forEach((r) => {
    lotById.set(r.id, r);
    lotByCode.set(`${r.material_id}|${r.lot_code}`, r);
  });

  const resolved = [];
  rawInputs.forEach((inp, idx) => {
    const where = `material_inputs[${idx}]`;
    if (!inp || typeof inp !== 'object') {
      throw new LotError('INVALID_REQUEST', `${where} 必须是 {material_id, lot_id?/lot_code?} 对象`);
    }
    const material_id = parseInt(inp.material_id, 10);
    if (!Number.isInteger(material_id)) {
      throw new LotError('INVALID_REQUEST', `${where} 缺少合法的 material_id`);
    }
    let material_lot_id = null;

    const hasLotId = inp.lot_id !== undefined && inp.lot_id !== null && inp.lot_id !== '';
    const hasLotCode = inp.lot_code !== undefined && inp.lot_code !== null && inp.lot_code !== '';
    if (hasLotId && hasLotCode) {
      throw new LotError('INVALID_REQUEST', `${where}：lot_id 与 lot_code 只能提供其一`);
    }
    if (hasLotId) {
      const lot_id = parseInt(inp.lot_id, 10);
      if (!Number.isInteger(lot_id)) {
        throw new LotError('INVALID_REQUEST', `${where}：lot_id 不合法`);
      }
      const row = lotById.get(lot_id);
      if (!row) {
        throw new LotError('LOT_NOT_FOUND', `${where}：供应批号 #${lot_id} 不存在`);
      }
      if (row.material_id !== material_id) {
        throw new LotError(
          'LOT_MATERIAL_MISMATCH',
          `${where}：供应批号 #${lot_id}（${row.lot_code}）属于原料 #${row.material_id}，` +
          `与本次输入原料 #${material_id} 不匹配`
        );
      }
      material_lot_id = row.id;
    } else if (hasLotCode) {
      const lot_code = String(inp.lot_code).trim();
      if (!lot_code) throw new LotError('INVALID_REQUEST', `${where}：lot_code 不能为空`);
      const row = lotByCode.get(`${material_id}|${lot_code}`);
      if (!row) {
        throw new LotError(
          'LOT_NOT_FOUND',
          `${where}：原料 #${material_id} 下不存在供应批号 "${lot_code}"，请先登记该批号`
        );
      }
      material_lot_id = row.id;
    }
    resolved.push({ material_id, material_lot_id });
  });
  return resolved;
}

module.exports = {
  LotError,
  createLot,
  getLot,
  listLots,
  flagLot,
  unflagLot,
  deleteLot,
  resolveMaterialInputs,
  formatLot
};
