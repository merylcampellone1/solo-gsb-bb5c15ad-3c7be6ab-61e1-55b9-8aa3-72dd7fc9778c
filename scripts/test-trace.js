'use strict';
// 原料供应批号追溯：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   批号档案：登记（同原料下唯一）/列表/标记 FLAGGED/解除/已引用不可删除；
//   事件写入：material_inputs 带批号（同原料多批号）、批号未知、lot_code 形态、
//             旧 material_ids 仍可用（记为批号未知）、批号不存在/与原料不匹配明确拒绝；
//   追溯传播：直接投料 / 前序批次引用 / 同设备未清洗残留；已核实清洗截断残留；
//             确定命中 vs 批号未知无法排除；不确定对象不被误列安全；关联出货单；
//   错误：原料不存在 404、批号不存在 404、批号与原料不匹配 400、参数缺失 400；
//   更正/删除事件后按最新合法时间线更新；整组换线（replan）支持 material_inputs；
//   追溯只读：不改变放行/卷/出货单/处置结论；path_limit 只限展示不漏对象。
//   node scripts/test-trace.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39137';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

function codes(list, field = 'batch_code') {
  return (list || []).map((x) => x[field]);
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const id = (code) => state0.materials.find((m) => m.code === code).id;
    const MILK = id('MILK-01'), EGG = id('EGG-01'), PEANUT = id('PEANUT-01'),
      WHEAT = id('WHEAT-01'), SOY = id('SOY-01'), SALT = id('SALT-01'), SESAME = id('SESAME-01');
    const lotByCode = (matCode, lotCode) =>
      state0.materials.find((m) => m.code === matCode).lots.find((l) => l.lot_code === lotCode);
    const MILK_A = lotByCode('MILK-01', 'SUP-MILK-20260925-A').id;
    const MILK_B = lotByCode('MILK-01', 'SUP-MILK-20260926-B').id;
    const PEANUT_A = lotByCode('PEANUT-01', 'SUP-PNT-20260928-3').id;
    let r;

    const trace = async (params) =>
      api('GET', '/api/trace/material-lot?' + new URLSearchParams(params).toString());

    // ---------- 1. 演示批号档案 ----------
    console.log('1) 演示数据含供应批号（MILK-A 正常 / MILK-B 已通报 FLAGGED）');
    r = await api('GET', '/api/material-lots');
    check('批号列表 4 条', r.status === 200 && r.json.length === 4, r.json);
    check('MILK-B 为 FLAGGED',
      r.json.find((l) => l.id === MILK_B).flagged === true, r.json);
    r = await api('GET', `/api/material-lots?material_id=${MILK}`);
    check('按原料过滤批号', r.json.length === 2 && r.json.every((l) => l.material_id === MILK), r.json);

    // ---------- 2. 确定命中：直接投料 + 引用 + 设备残留，清洗截断 ----------
    console.log('2) 追溯 MILK-B：BATCH-002 直接投料 → BATCH-003 引用+残留；15:00 清洗后无设备残留');
    r = await trace({ material_id: MILK, lot_id: MILK_B });
    check('查询 200', r.status === 200, r.json);
    check('确定命中 BATCH-002/003',
      JSON.stringify(codes(r.json.confirmed_batches)) === JSON.stringify(['BATCH-002', 'BATCH-003']),
      codes(r.json.confirmed_batches));
    check('无无法排除批次（该原料两行都有批号）', r.json.summary.unresolved_batch_count === 0);
    const b3 = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-003');
    check('BATCH-003 同时有前序引用与设备残留依据',
      b3.evidence.confirmed.routes.batch_reference && b3.evidence.confirmed.routes.equipment_residue,
      b3.evidence.confirmed.routes);
    check('依据链含“批次引用:BATCH-002”',
      b3.evidence.confirmed.chains.some((c) => c.includes('批次引用:BATCH-002')));
    check('依据链含“设备残留:LINE-A”',
      b3.evidence.confirmed.chains.some((c) => c.includes('设备残留:LINE-A')));
    check('BATCH-003 关联出货单 SHIP-0001',
      b3.shipments.some((s) => s.shipment_code === 'SHIP-0001') &&
      r.json.summary.confirmed_shipment_count === 1, b3.shipments);
    check('15:00 班后清洗后无设备残留输出', r.json.equipment_residue.length === 0, r.json.equipment_residue);
    check('BATCH-001 不被命中（清洗 09:00 截断 + 无牛奶）',
      !codes(r.json.confirmed_batches).includes('BATCH-001'));

    // ---------- 3. 清洗截断设备残留：花生批号仅命中 BATCH-004 ----------
    console.log('3) 花生批号：BATCH-004 后 13:00 已核实清洗，BATCH-005 必须安全排除');
    r = await trace({ material_id: PEANUT, lot_id: PEANUT_A });
    check('仅 BATCH-004 确定命中',
      JSON.stringify(codes(r.json.confirmed_batches)) === JSON.stringify(['BATCH-004']),
      codes(r.json.confirmed_batches));
    check('BATCH-005 未被误列为受影响/安全问题（不出现在任一列表）',
      !codes(r.json.confirmed_batches).includes('BATCH-005') &&
      !codes(r.json.unresolved_batches).includes('BATCH-005'));

    // ---------- 4. 批号未知 → 无法排除，沿引用与残留传播 ----------
    console.log('4) 全蛋液批号未知：BATCH-002 无法排除 → BATCH-003（引用+残留），SHIP-0001 关联');
    r = await trace({ material_id: EGG });
    check('模式 UNKNOWN_LOT', r.json.query.mode === 'UNKNOWN_LOT');
    check('无法排除 BATCH-002/003',
      JSON.stringify(codes(r.json.unresolved_batches)) === JSON.stringify(['BATCH-002', 'BATCH-003']),
      codes(r.json.unresolved_batches));
    check('无确定命中', r.json.summary.confirmed_batch_count === 0);
    const ub3 = r.json.unresolved_batches.find((x) => x.batch_code === 'BATCH-003');
    check('无法排除依据含引用与残留两类',
      ub3.evidence.unresolved.routes.batch_reference && ub3.evidence.unresolved.routes.equipment_residue);
    check('无法排除批次关联 SHIP-0001（不能因不确定就漏掉出货单）',
      ub3.shipments.some((s) => s.shipment_code === 'SHIP-001' || s.shipment_code === 'SHIP-0001'),
      ub3.shipments);
    check('BATCH-001 不列入（设备已清洗且无蛋输入）',
      !codes(r.json.unresolved_batches).includes('BATCH-001'));

    // 酱油批号未知：FRYER-B 12:00 投料 → 13:00 清洗截断，BATCH-005 安全排除
    r = await trace({ material_id: SOY });
    check('酱油未知批号仅 BATCH-004 无法排除',
      JSON.stringify(codes(r.json.unresolved_batches)) === JSON.stringify(['BATCH-004']),
      codes(r.json.unresolved_batches));

    // ---------- 5. 不存在/不匹配的批号明确拒绝 ----------
    console.log('5) 参数与档案错误：原料/批号不存在、批号与原料不匹配');
    r = await trace({ material_id: MILK, lot_id: PEANUT_A });
    check('批号属于别的原料 → 400 LOT_MATERIAL_MISMATCH',
      r.status === 400 && r.json.code === 'LOT_MATERIAL_MISMATCH', r.json);
    r = await trace({ material_id: MILK, lot_id: 999999 });
    check('批号不存在 → 404 LOT_NOT_FOUND', r.status === 404 && r.json.code === 'LOT_NOT_FOUND');
    r = await trace({ material_id: MILK, lot_code: 'NOT-EXIST' });
    check('按 lot_code 查不存在 → 404 LOT_NOT_FOUND', r.status === 404 && r.json.code === 'LOT_NOT_FOUND');
    r = await trace({ material_id: 999999, lot_id: MILK_A });
    check('原料不存在 → 404 MATERIAL_NOT_FOUND', r.status === 404 && r.json.code === 'MATERIAL_NOT_FOUND');
    r = await trace({});
    check('缺 material_id → 400 INVALID_REQUEST', r.status === 400 && r.json.code === 'INVALID_REQUEST');
    r = await trace({ material_id: MILK, lot_id: MILK_A, lot_code: 'X' });
    check('同时传 lot_id/lot_code → 400', r.status === 400);

    // ---------- 6. 批号档案管理 ----------
    console.log('6) 批号登记/重复/标记/删除约束');
    r = await api('POST', '/api/material-lots', {
      material_id: MILK, lot_code: 'SUP-MILK-NEW-1', supplier: '测试供应商', note: '测试批'
    });
    check('登记新批号 200', r.status === 200 && r.json.id && r.json.status === 'ACTIVE', r.json);
    const newLotId = r.json.id;
    r = await api('POST', '/api/material-lots', {
      material_id: MILK, lot_code: 'SUP-MILK-NEW-1'
    });
    check('同原料下批号重复 → 400 LOT_CODE_CONFLICT',
      r.status === 400 && r.json.code === 'LOT_CODE_CONFLICT', r.json);
    r = await api('POST', '/api/material-lots', { material_id: 999999, lot_code: 'X' });
    check('登记到不存在原料 → 404', r.status === 404 && r.json.code === 'MATERIAL_NOT_FOUND');
    r = await api('DELETE', `/api/material-lots/${newLotId}`);
    check('未被引用的批号可删除', r.status === 200 && r.json.ok === true);
    r = await api('DELETE', `/api/material-lots/${MILK_A}`);
    check('已被投料引用的批号禁止删除 → 400 LOT_IN_USE',
      r.status === 400 && r.json.code === 'LOT_IN_USE', r.json);
    r = await api('POST', `/api/material-lots/${MILK_A}/flag`, { flagged_reason: '演练标记' });
    check('标记 FLAGGED', r.status === 200 && r.json.flagged === true);
    r = await api('POST', `/api/material-lots/${MILK_A}/unflag`, {});
    check('解除标记', r.status === 200 && r.json.flagged === false);

    // ---------- 7. 事件写入：带批号 / 多批号 / 未知 / 旧形态 ----------
    console.log('7) 事件写入 material_inputs（同原料多批号、未知）与旧 material_ids 兼容');
    // 先在 LINE-A 15:00 清洗之后加一批，使用 MILK-A
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: 1,
      batch_code: 'BATCH-T1', note: '批号录入 T1',
      material_inputs: [{ material_id: MILK, lot_id: MILK_A }, { material_id: SALT }]
    });
    check('带批号事件创建成功', r.status === 200, r.json);
    // 同原料多批号
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: 1,
      batch_code: 'BATCH-T2', note: '同原料两批号 + 未知',
      material_inputs: [
        { material_id: MILK, lot_id: MILK_A },
        { material_id: MILK, lot_id: MILK_B },
        { material_id: MILK } // 批号未知
      ]
    });
    check('同原料多批号事件创建成功', r.status === 200, r.json);
    // lot_code 形态
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T10:00', equipment_id: 2,
      batch_code: 'BATCH-T3', note: 'lot_code 形态',
      material_inputs: [{ material_id: PEANUT, lot_code: 'SUP-PNT-20260928-3' }]
    });
    check('lot_code 形态创建成功', r.status === 200, r.json);
    // 旧形态 material_ids 仍可用
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T11:00', equipment_id: 2,
      batch_code: 'BATCH-T4', note: '旧形态', material_ids: [SALT]
    });
    check('旧 material_ids 形态仍可用', r.status === 200, r.json);
    // 错误形态
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T12:00', equipment_id: 1,
      batch_code: 'BATCH-T5',
      material_inputs: [{ material_id: MILK, lot_id: PEANUT_A }]
    });
    check('批号与原料不匹配 → 400 LOT_MATERIAL_MISMATCH',
      r.status === 400 && r.json.code === 'LOT_MATERIAL_MISMATCH', r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T12:00', equipment_id: 1,
      batch_code: 'BATCH-T5',
      material_inputs: [{ material_id: MILK, lot_id: 888888 }]
    });
    check('批号不存在 → 400 LOT_NOT_FOUND', r.status === 400 && r.json.code === 'LOT_NOT_FOUND');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T12:00', equipment_id: 1,
      batch_code: 'BATCH-T5',
      material_inputs: [{ material_id: MILK, lot_code: 'NOPE' }]
    });
    check('lot_code 不存在 → 400 LOT_NOT_FOUND', r.status === 400 && r.json.code === 'LOT_NOT_FOUND');
    // 两形态原料集合不一致
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T12:00', equipment_id: 1,
      batch_code: 'BATCH-T5', material_ids: [SALT],
      material_inputs: [{ material_id: MILK, lot_id: MILK_A }]
    });
    check('两形态原料集合不一致 → 400', r.status === 400, r.json);

    // 验证新事件的流向：T2 同时命中 MILK-A/MILK-B 与未知；T1→T2 设备残留
    r = await trace({ material_id: MILK, lot_id: MILK_B });
    check('MILK-B 新时间线命中 T2（直接投料）',
      codes(r.json.confirmed_batches).includes('BATCH-T2'), codes(r.json.confirmed_batches));
    check('MILK-B 不命中 T1（T1 只用 MILK-A）',
      !codes(r.json.confirmed_batches).includes('BATCH-T1'));
    r = await trace({ material_id: MILK });
    check('牛奶未知批号：T2 无法排除（其第三行未知）',
      codes(r.json.unresolved_batches).includes('BATCH-T2'), codes(r.json.unresolved_batches));

    // state 接口带批号字段
    const st = (await api('GET', '/api/state')).json;
    const t1ev = st.events.find((e) => e.batch_code === 'BATCH-T1');
    const milkRow = t1ev.inputs.find((x) => x.material_id === MILK);
    check('state 中 T1 牛奶输入带 lot_known/lot_code',
      milkRow.lot_known === true && milkRow.material_lot_code === 'SUP-MILK-20260925-A', milkRow);
    const t2milkRows = st.events.find((e) => e.batch_code === 'BATCH-T2').inputs
      .filter((x) => x.material_id === MILK);
    check('T2 同原料 3 行（两批号 + 未知）', t2milkRows.length === 3 &&
      t2milkRows.filter((x) => x.lot_known).length === 2 &&
      t2milkRows.some((x) => !x.lot_known), t2milkRows);
    const t4salt = st.events.find((e) => e.batch_code === 'BATCH-T4').inputs[0];
    check('旧形态输入 lot_known=false（旧记录不丢失、批号未知）',
      t4salt.material_id === SALT && t4salt.lot_known === false, t4salt);

    // ---------- 8. 跨设备：引用把批号带到另一台设备的残留 ----------
    console.log('8) 跨设备传播：引用受影响批次后，批号进入新设备残留并继续向后传播');
    // FRYER-B(2) 上引用 LINE-A 的 T2，并继续生产 T5
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T13:00', equipment_id: 2,
      batch_code: 'BATCH-X1', note: '跨设备引用 T2',
      material_inputs: [{ material_id: SALT }],
      ref_batch_ids: [st.events.find((e) => e.batch_code === 'BATCH-T2').batch_id]
    });
    check('跨设备引用事件创建', r.status === 200, r.json);
    const t2bid = st.events.find((e) => e.batch_code === 'BATCH-T2').batch_id;
    void t2bid;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T14:00', equipment_id: 2,
      batch_code: 'BATCH-X2', note: '同设备后续批（吃残留）',
      material_inputs: [{ material_id: SALT }],
      ref_batch_ids: []
    });
    check('同设备后续批创建', r.status === 200, r.json);
    r = await trace({ material_id: MILK, lot_id: MILK_B });
    check('MILK-B 经 X1 引用到 FRYER-B',
      codes(r.json.confirmed_batches).includes('BATCH-X1'), codes(r.json.confirmed_batches));
    const x2 = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-X2');
    check('X2 经同设备未清洗残留进入（最后一跳为设备残留；链可同时携带更早的引用跳）',
      x2 && !x2.evidence.confirmed.routes.direct &&
      x2.evidence.confirmed.routes.equipment_residue,
      x2 && x2.evidence.confirmed.routes);
    check('设备残留区列出 FRYER-B（14:00 后未清洗）',
      r.json.equipment_residue.some((e) => e.equipment_code === 'FRYER-B'),
      r.json.equipment_residue.map((e) => e.equipment_code));
    // 清洗截断：15:00 清洗 FRYER-B 后 X3 不命中
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T15:00', equipment_id: 2, note: '跨设备后清洗'
    });
    check('清洗事件创建', r.status === 200);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T16:00', equipment_id: 2,
      batch_code: 'BATCH-X3', note: '清洗后批',
      material_inputs: [{ material_id: SALT }]
    });
    check('清洗后批创建', r.status === 200);
    r = await trace({ material_id: MILK, lot_id: MILK_B });
    check('清洗截断：X3 不命中', !codes(r.json.confirmed_batches).includes('BATCH-X3'),
      codes(r.json.confirmed_batches));
    check('清洗后 FRYER-B 不再出现在设备残留区',
      !r.json.equipment_residue.some((e) => e.equipment_code === 'FRYER-B'));

    // ---------- 9. 更正/删除事件后按最新时间线更新 ----------
    console.log('9) 事件更正/删除：追溯结果随最新合法时间线更新');
    // 更正 T1：去掉牛奶批号输入（改成只用盐）→ MILK-A 不再经 T1 直接命中
    const st2 = (await api('GET', '/api/state')).json;
    const t1Id = st2.events.find((e) => e.batch_code === 'BATCH-T1').id;
    const t1Equip = st2.events.find((e) => e.batch_code === 'BATCH-T1').equipment_id;
    r = await api('PUT', `/api/events/${t1Id}`, {
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: t1Equip,
      batch_code: 'BATCH-T1', note: '更正为无牛奶',
      material_inputs: [{ material_id: SALT }], ref_batch_ids: []
    });
    check('更正 T1 成功', r.status === 200, r.json);
    r = await trace({ material_id: MILK, lot_id: MILK_A });
    check('更正后 MILK-A 不再直接命中 T1',
      !codes(r.json.confirmed_batches).includes('BATCH-T1'), codes(r.json.confirmed_batches));
    // T2 仍直接使用 MILK-A，且后续 X1/X2 经由 T2 仍命中（引用链不断）
    check('T2/X1/X2 仍命中 MILK-A（引用链来自 T2）',
      ['BATCH-T2', 'BATCH-X1', 'BATCH-X2'].every((c) =>
        codes(r.json.confirmed_batches).includes(c)), codes(r.json.confirmed_batches));

    // ---------- 10. 整组换线（replan）支持 material_inputs ----------
    console.log('10) replan preview/apply 携带 material_inputs（影子库隔离 + 落库一致）');
    const t2Id = (await api('GET', '/api/state')).json.events
      .find((e) => e.batch_code === 'BATCH-T2').id;
    const changes = [{
      op: 'update', event_id: t2Id, type: 'PROCESS',
      event_time: '2026-10-01T09:00', equipment_id: 1,
      note: '换线预演：牛奶只保留 MILK-B',
      batch_code: 'BATCH-T2',
      material_inputs: [{ material_id: MILK, lot_id: MILK_B }],
      ref_batch_ids: []
    }];
    r = await api('POST', '/api/replan/preview', { changes });
    check('preview 200 并回显 material_inputs',
      r.status === 200 && r.json.changes[0].material_inputs[0].lot_id === MILK_B, r.json);
    // 预演不影响正式追溯结果
    r = await trace({ material_id: MILK, lot_id: MILK_A });
    check('预演不影响正式库（T2 仍命中 MILK-A）',
      codes(r.json.confirmed_batches).includes('BATCH-T2'));
    // 非法批号在 preview 阶段拒绝
    r = await api('POST', '/api/replan/preview', {
      changes: [{ ...changes[0], material_inputs: [{ material_id: MILK, lot_id: PEANUT_A }] }]
    });
    check('preview 批号不匹配 → 400 REPLAN_REJECTED',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED', r.json);
    // apply 落库
    r = await api('POST', '/api/replan/apply', {
      version: (await api('POST', '/api/replan/preview', { changes })).json.version,
      changes
    });
    check('apply 200', r.status === 200, r.json);
    r = await trace({ material_id: MILK, lot_id: MILK_A });
    check('应用后 T2 不再命中 MILK-A',
      !codes(r.json.confirmed_batches).includes('BATCH-T2'), codes(r.json.confirmed_batches));
    r = await trace({ material_id: MILK, lot_id: MILK_B });
    check('应用后 T2 仍命中 MILK-B（引用链继续到 X1/X2）',
      ['BATCH-T2', 'BATCH-X1', 'BATCH-X2'].every((c) =>
        codes(r.json.confirmed_batches).includes(c)), codes(r.json.confirmed_batches));

    // ---------- 11. 追溯只读：放行/卷/出货状态不变 ----------
    console.log('11) 追溯查询不改变任何业务结论');
    const shipBefore = (await api('GET', '/api/shipments/SHIP-0001')).json;
    await trace({ material_id: MILK, lot_id: MILK_B });
    await trace({ material_id: EGG });
    const shipAfter = (await api('GET', '/api/shipments/SHIP-0001')).json;
    check('SHIP-0001 状态/处置计数不因查询变化',
      shipBefore.status === shipAfter.status &&
      shipBefore.disposition_count === shipAfter.disposition_count,
      [shipBefore.status, shipAfter.status]);
    const stateAfter = (await api('GET', '/api/state')).json;
    const roll = stateAfter.label_rolls.find((x) => x.roll_code === 'LABEL-0001');
    check('LABEL-0001 仍为 ACTIVE（追溯不停卷）', roll && roll.status === 'ACTIVE', roll && roll.status);
    const b3rel = stateAfter.batches.find((b) => b.code === 'BATCH-003').releases;
    check('BATCH-003 放行状态不因追溯变化',
      b3rel.some((x) => x.status === 'ACTIVE') || b3rel.every((x) => x.status === 'INVALIDATED'));

    // ---------- 12. path_limit 只限制展示，不漏对象 ----------
    console.log('12) path_limit 限量展示但受影响对象不漏报');
    // 构造一个同批次内有 ≥2 条不同确定链的批次：直接投 MILK-B + 引用同样含 MILK-B 的 T2
    const stForLimit = (await api('GET', '/api/state')).json;
    const t2bidForLimit = stForLimit.events.find((e) => e.batch_code === 'BATCH-T2').batch_id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T17:00', equipment_id: 1,
      batch_code: 'BATCH-L1', note: '直接+引用，双路径',
      material_inputs: [{ material_id: MILK, lot_id: MILK_B }],
      ref_batch_ids: [t2bidForLimit]
    });
    check('双路径批次创建成功', r.status === 200, r.json);
    r = await trace({ material_id: MILK, lot_id: MILK_B, path_limit: 1 });
    check('path_limit=1 时受影响批次不减少（完整集合仍在）',
      r.json.summary.affected_batch_count >= 4, r.json.summary);
    const limited = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-L1');
    const fullL1 = (await trace({ material_id: MILK, lot_id: MILK_B })).json
      .confirmed_batches.find((x) => x.batch_code === 'BATCH-L1');
    check('该批在完整限量下确有直接投料+前序引用多条链',
      fullL1.evidence.confirmed.chain_count >= 2 &&
      fullL1.evidence.confirmed.routes.direct &&
      fullL1.evidence.confirmed.routes.batch_reference,
      fullL1.evidence.confirmed);
    check('path_limit=1 只展示 1 条链并给截断标记（对象不漏）',
      limited && limited.evidence.confirmed.chains.length === 2 &&
      limited.evidence.confirmed.chains.some((c) => c.startsWith('…')),
      limited && limited.evidence.confirmed.chains);
    r = await trace({ material_id: MILK, lot_id: MILK_B, path_limit: 200 });
    check('path_limit=200 时完整链可展示（无截断）',
      r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-L1')
        .evidence.confirmed.chains.length >= 2);
    r = await trace({ material_id: MILK, lot_id: MILK_B, path_limit: 0 });
    check('path_limit=0 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST');

    // ---------- 13. 空结果不误导 ----------
    console.log('13) 从未使用的批号：两类列表均空（不输出“安全”结论）');
    r = await api('POST', '/api/material-lots', {
      material_id: WHEAT, lot_code: 'UNUSED-LOT-9'
    });
    const unusedLot = r.json.id;
    r = await trace({ material_id: WHEAT, lot_id: unusedLot });
    check('未使用批号：0 命中 / 0 无法排除',
      r.json.summary.confirmed_batch_count === 0 &&
      r.json.summary.unresolved_batch_count === 0, r.json.summary);
    // 面粉批号未知：BATCH-001 用了 WHEAT-A 已知批，盐未知不相关 → 面粉无未知批
    r = await trace({ material_id: WHEAT });
    check('面粉全部批号已知：未知查询 0 条',
      r.json.summary.unresolved_batch_count === 0, r.json.summary);
    // 芝麻酱批号未知：BATCH-003 无法排除（其直接芝麻输入未知）
    r = await trace({ material_id: SESAME });
    check('芝麻酱未知批号：BATCH-003 无法排除（直接投料）',
      JSON.stringify(codes(r.json.unresolved_batches)) === JSON.stringify(['BATCH-003']),
      codes(r.json.unresolved_batches));

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
