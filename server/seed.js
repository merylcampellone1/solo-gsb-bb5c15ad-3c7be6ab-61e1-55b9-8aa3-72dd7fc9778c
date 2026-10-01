'use strict';
// 首次启动时写入演示数据（仅当原料表为空时），随后执行一次全量推导。
const { getDb } = require('./db');
const { recompute, sortedJson } = require('./recompute');

function seedIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS c FROM materials').get().c;
  if (count > 0) return false;

  const batchIds = {};
  const insertBase = db.transaction(() => {
    const insMaterial = db.prepare(
      'INSERT INTO materials (code, name, allergens) VALUES (?,?,?)'
    );
    const insEquip = db.prepare(
      'INSERT INTO equipment (code, name) VALUES (?,?)'
    );
    const insBatch = db.prepare('INSERT INTO batches (code) VALUES (?)');
    const insEvent = db.prepare(
      `INSERT INTO events (event_time, type, equipment_id, batch_id, note)
       VALUES (?,?,?,?,?)`
    );
    const insInput = db.prepare(
      'INSERT INTO process_inputs (event_id, material_id, batch_id) VALUES (?,?,?)'
    );

    const mats = {};
    const addMat = (code, name, allergens) => {
      mats[code] = insMaterial.run(code, name, JSON.stringify(allergens)).lastInsertRowid;
    };
    addMat('WHEAT-01', '小麦面粉', ['含麸质的谷物']);
    addMat('SOY-01', '酿造酱油', ['大豆', '含麸质的谷物']);
    addMat('MILK-01', '全脂奶粉', ['乳']);
    addMat('EGG-01', '全蛋液', ['蛋']);
    addMat('SESAME-01', '芝麻酱', ['芝麻']);
    addMat('PEANUT-01', '花生碎', ['花生']);
    addMat('SALT-01', '食用盐', []);

    const lineA = insEquip.run('LINE-A', '烘焙A线').lastInsertRowid;
    const fryerB = insEquip.run('FRYER-B', '油炸B线').lastInsertRowid;

    ['BATCH-001', 'BATCH-002', 'BATCH-003', 'BATCH-004', 'BATCH-005', 'BATCH-DEMO-U1', 'BATCH-DEMO-U2']
      .forEach((code) => { batchIds[code] = insBatch.run(code).lastInsertRowid; });

    const D = '2026-09-30T';
    const process = (time, equip, bid, note) =>
      insEvent.run(D + time, 'PROCESS', equip, bid, note).lastInsertRowid;
    const clean = (time, equip, note) =>
      insEvent.run(D + time, 'CLEAN', equip, null, note).lastInsertRowid;
    // 原料投料可登记供应批号（lot 省略即批号未知）；同一原料在一次加工中可投多个批号。
    const insMatLot = db.prepare(
      'INSERT INTO process_inputs (event_id, material_id, batch_id, supplier_lot) VALUES (?,?,?,?)'
    );
    const matInput = (eid, code, lot) =>
      insMatLot.run(eid, mats[code], null, lot === undefined ? null : lot).lastInsertRowid;
    const batchInput = (eid, code) => insInput.run(eid, null, batchIds[code]);

    const e1 = process('08:00', lineA, batchIds['BATCH-001'], '早班面团');
    matInput(e1, 'WHEAT-01', 'WHT-20260920-A');
    // 同一原料一次加工使用多个供应批号（新旧两批小麦粉）：
    matInput(e1, 'WHEAT-01', 'WHT-20260925-A');
    matInput(e1, 'SALT-01'); // 旧方式未登记批号 → 批号未知

    clean('09:00', lineA, '换线前已核实清洗');

    const e3 = process('10:00', lineA, batchIds['BATCH-002'], '蛋糕糊');
    matInput(e3, 'MILK-01', 'MLK-20260928-A');
    matInput(e3, 'EGG-01', 'EGG-20260928-B');

    const e4 = process('11:00', lineA, batchIds['BATCH-003'], '芝麻风味蛋糕糊（引用上一批）');
    matInput(e4, 'SESAME-01', 'SES-20260920-A');
    batchInput(e4, 'BATCH-002');

    const e5 = process('12:00', fryerB, batchIds['BATCH-004'], '裹粉花生');
    matInput(e5, 'PEANUT-01', 'PNT-20260925-X');
    matInput(e5, 'SOY-01', 'SOY-20260920-A');

    clean('13:00', fryerB, '已核实清洗（CIP + 目视复核）');

    const e7 = process('14:00', fryerB, batchIds['BATCH-005'], '清洗后空白验证批');
    matInput(e7, 'SALT-01');

    clean('15:00', lineA, '班后已核实清洗');

    // 批号未知演示：16:00 LINE-A 投批号未知的全脂奶粉（旧写法/未登记批号），
    // 17:00 同设备未清洗再加工（仅引用），用于展示“因批号未知无法排除”的 POSSIBLE 传播。
    const e8 = process('16:00', lineA, batchIds['BATCH-DEMO-U1'], '夜班奶糊（奶粉批号未登记）');
    matInput(e8, 'MILK-01'); // 批号未知
    const e9 = process('17:00', lineA, batchIds['BATCH-DEMO-U2'], '夜班二套（引用上一批，同设备未清洗）');
    matInput(e9, 'SALT-01');
    batchInput(e9, 'BATCH-DEMO-U1');

    clean('17:30', lineA, '夜班批号未知演示后已核实清洗');
  });
  insertBase();

  // 推导一次后，按“当时结果”为 BATCH-003 登记放行
  recompute(db);
  const out = db.prepare(
    'SELECT allergens FROM batch_outputs WHERE batch_id = ?'
  ).get(batchIds['BATCH-003']);
  const releaseId = db.prepare(
    `INSERT INTO releases (batch_id, released_at, released_by, snapshot_allergens, status, created_event_seq)
     VALUES (?,?,?,?,'ACTIVE',(SELECT COUNT(*) FROM events))`
  ).run(batchIds['BATCH-003'], '2026-09-30T11:30', '质检员-王敏',
        sortedJson(JSON.parse(out.allergens))).lastInsertRowid;

  // 为本次包装登记一卷过敏原标签（拟印集合与当前推导、放行快照一致；印量 500）
  const snapshot = sortedJson(JSON.parse(out.allergens));
  const rollId = db.prepare(
    `INSERT INTO label_rolls
       (roll_code, batch_id, release_id, print_qty, applied_qty, void_qty,
        revision, allergen_set, registered_at, registered_by, status, retired_reason)
     VALUES ('', ?, ?, 500, 120, 5, 2, ?, '2026-09-30T12:10', '包装组长-李雷', 'ACTIVE', '')`
  ).run(batchIds['BATCH-003'], releaseId, snapshot).lastInsertRowid;
  db.prepare('UPDATE label_rolls SET roll_code = ? WHERE id = ?')
    .run(`LABEL-${String(rollId).padStart(4, '0')}`, rollId);
  db.prepare(
    `INSERT INTO label_roll_usages (roll_id, used_at, applied_qty, void_qty, expected_revision, used_by)
     VALUES (?, '2026-09-30T13:05', 100, 3, 0, '包装工-赵强'),
            (?, '2026-09-30T13:40', 20, 2, 1, '包装工-赵强')`
  ).run(rollId, rollId);

  // 演示出货单 SHIP-0001：从 LABEL-0001（修订号 2，已贴 120）分配 100 张。
  // 出货当时保存放行标识、过敏原集合、卷号与修订号快照；该卷此时仍有 20 张已贴可出货。
  const shipId = db.prepare(
    `INSERT INTO shipments
       (shipment_code, batch_id, batch_code, ship_qty, allergen_set,
        status, review_reason, shipped_at, shipped_by)
     VALUES ('', ?, 'BATCH-003', 100, ?, 'SHIPPED', '', '2026-09-30T14:20', '仓管-孙倩')`
  ).run(batchIds['BATCH-003'], snapshot).lastInsertRowid;
  db.prepare('UPDATE shipments SET shipment_code = ? WHERE id = ?')
    .run(`SHIP-${String(shipId).padStart(4, '0')}`, shipId);
  db.prepare(
    `INSERT INTO shipment_items
       (shipment_id, roll_id, roll_code, release_id, release_at, release_by,
        allergen_set, roll_revision, qty)
     VALUES (?, ?, 'LABEL-0001', ?, '2026-09-30T11:30', '质检员-王敏', ?, 2, 100)`
  ).run(shipId, rollId, releaseId, snapshot);

  return true;
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  const seeded = seedIfEmpty();
  console.log(seeded ? '演示数据已初始化' : '数据已存在，跳过演示数据');
}
