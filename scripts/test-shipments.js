'use strict';
// 包装出货：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   批次可出货余额；出货整单成功（返回单号/状态、保存放行标识/过敏原/卷号/修订号快照）；
//   整单拒绝：缺批次/出货量非正整数/缺操作人/空分配/重复卷/卷不属于批次/卷不存在/
//             卷已停用/放行失效/分配和≠出货量/累计超已贴；任一失败不占用数量（事务回滚）；
//   原料或事件变更、放行删除导致卷停用 → 相关已出货单 PENDING_REVIEW 且原因可查、不自动恢复；
//   停卷尚未分配的已贴张数不可再出货；
//   出货记录不因后续更正/放行删除消失；出货单状态/明细查询；
//   整组换线预演预测待评估、确认应用实际置位、影子库隔离。
//   node scripts/test-shipments.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39129';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipments-test-'));
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
    const D = '2026-09-30T';
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const rel3 = b3.releases.find((r) => r.status === 'ACTIVE');
    const e3 = state0.events.find((e) => e.batch_code === 'BATCH-002');
    const peanut = state0.materials.find((m) => m.code === 'PEANUT-01').id;
    const set3 = ['蛋', '乳', '芝麻'];
    const demoRoll = state0.label_rolls.find((r) => r.roll_code === 'LABEL-0001');

    // ---------- 1. 演示数据自带一单出货 ----------
    console.log('1) 演示数据自带 SHIP-0001（100 张，来自 LABEL-0001）');
    check('state 含 shipments 数组', Array.isArray(state0.shipments));
    check('初始 1 张出货单', state0.shipments.length === 1, state0.shipments);
    const demoShip = state0.shipments[0];
    check('单号 SHIP-0001 / 状态 SHIPPED',
      demoShip.shipment_code === 'SHIP-0001' && demoShip.status === 'SHIPPED', demoShip);
    check('出货量 100 / 已分配 100',
      demoShip.ship_qty === 100 && demoShip.allocated_qty === 100, demoShip);
    check('快照过敏原为 蛋/乳/芝麻',
      JSON.stringify(demoShip.allergens) === JSON.stringify(set3), demoShip.allergens);
    const dItem = demoShip.items[0];
    check('明细保存卷号/修订号/放行标识',
      dItem.roll_code === 'LABEL-0001' && dItem.roll_revision === 2 &&
      dItem.release_id === rel3.id, dItem);
    check('明细放行快照（时间/人）保留',
      dItem.release_at === '2026-09-30T11:30' && dItem.release_by === '质检员-王敏', dItem);

    // ---------- 2. 可出货余额 ----------
    console.log('2) 批次可出货余额：已贴 120 - 已分配 100 = 20');
    let r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    check('余额 200', r.status === 200 && r.json.shippable_qty === 20, r.json);
    check('余额逐卷含 allocated/available',
      r.json.rolls[0].allocated_qty === 100 && r.json.rolls[0].available_qty === 20, r.json.rolls);
    const b1 = state0.batches.find((b) => b.code === 'BATCH-001');
    r = await api('GET', `/api/batches/${b1.id}/shipment-balance`);
    check('无标签卷批次余额 0', r.status === 200 && r.json.shippable_qty === 0, r.json);
    r = await api('GET', '/api/batches/999999/shipment-balance');
    check('不存在批次 → 400 BATCH_NOT_FOUND',
      r.status === 400 && r.json.code === 'BATCH_NOT_FOUND', r.json);
    r = await api('GET', '/api/shipment-balances');
    check('全部批次余额接口 200', r.status === 200 && Array.isArray(r.json) && r.json.length >= 5, r.json);
    check('卷对象含 allocated_qty / shippable_qty',
      demoRoll.allocated_qty === 100 && demoRoll.shippable_qty === 20, demoRoll);

    // ---------- 3. 准备更多可出货数量（新卷 + 核销贴用）----------
    console.log('3) 准备第二卷 LABEL-0002 并核销贴用 50（可出货 50）');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3.id, allergens: set3,
      print_qty: 500, registered_by: '组长'
    });
    check('登记第二卷 200', r.status === 200 && r.json.roll_code === 'LABEL-0002', r.json);
    const roll2Id = r.json.id;
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 0, applied: 50, voided: 0, used_by: '赵强' });
    check('核销贴用 50 成功，rev→1', r.status === 200 && r.json.revision === 1, r.json);

    // ---------- 4. 正常出货：两卷分配，返回单号/状态/快照 ----------
    console.log('4) 正常出货 30：LABEL-0001 分配 20 + LABEL-0002 分配 10');
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id,
      ship_qty: 30,
      shipped_by: '仓管-周杰',
      shipped_at: D + '15:00',
      allocations: [
        { roll_id: demoRoll.id, qty: 20 },
        { roll_id: roll2Id, qty: 10 }
      ]
    });
    check('出货 200', r.status === 200, r);
    check('单号 SHIP-0002 / 状态 SHIPPED',
      r.json.shipment_code === 'SHIP-0002' && r.json.status === 'SHIPPED', r.json);
    check('出货量/已分配均 30',
      r.json.ship_qty === 30 && r.json.allocated_qty === 30, r.json);
    check('两卷明细且修订号为当时值（2 与 1）',
      r.json.items.length === 2 &&
      r.json.items.find((i) => i.roll_code === 'LABEL-0001').roll_revision === 2 &&
      r.json.items.find((i) => i.roll_code === 'LABEL-0002').roll_revision === 1,
      r.json.items);
    check('每条明细放行标识/过敏原快照齐全',
      r.json.items.every((i) => i.release_id === rel3.id &&
        JSON.stringify(i.allergens) === JSON.stringify(set3)), r.json.items);
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    check('出货后 LABEL-0001 余额 0、LABEL-0002 余额 40，整批 40',
      r.json.shippable_qty === 40 &&
      r.json.rolls.find((x) => x.roll_code === 'LABEL-0001').available_qty === 0 &&
      r.json.rolls.find((x) => x.roll_code === 'LABEL-0002').available_qty === 40,
      r.json);

    // ---------- 5. 整单拒绝：基础校验 ----------
    console.log('5) 整单拒绝：缺批次 / 出货量非正整数 / 缺操作人 / 空分配 / 重复卷');
    for (const bad of [
      { body: { ship_qty: 10, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 10 }] }, why: '缺批次' },
      { body: { batch_id: b3.id, ship_qty: 0, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 0 }] }, why: '出货量 0' },
      { body: { batch_id: b3.id, ship_qty: -3, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 1 }] }, why: '负出货量' },
      { body: { batch_id: b3.id, ship_qty: 1.5, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 1 }] }, why: '小数' },
      { body: { batch_id: b3.id, ship_qty: 10, shipped_by: '  ', allocations: [{ roll_id: roll2Id, qty: 10 }] }, why: '操作人空' },
      { body: { batch_id: b3.id, ship_qty: 10, shipped_by: 'x', allocations: [] }, why: '空分配' },
      { body: { batch_id: b3.id, ship_qty: 10, shipped_by: 'x' }, why: '无 allocations' },
      { body: { batch_id: b3.id, ship_qty: 20, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 10 }, { roll_id: roll2Id, qty: 10 }] }, why: '重复卷' },
      { body: { batch_id: 999999, ship_qty: 10, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 10 }] }, why: '批次不存在' }
    ]) {
      r = await api('POST', '/api/shipments', bad.body);
      check(`${bad.why} → 400 INVALID_REQUEST/BATCH_NOT_FOUND`,
        r.status === 400 && ['INVALID_REQUEST', 'BATCH_NOT_FOUND'].includes(r.json.code),
        { why: bad.why, resp: r.json });
    }

    // ---------- 6. 整单拒绝：卷约束 ----------
    console.log('6) 整单拒绝：卷不存在 / 卷不属于批次 / 分配张数非正整数');
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 5, shipped_by: 'x', allocations: [{ roll_id: 999999, qty: 5 }]
    });
    check('卷不存在 → 404 ROLL_NOT_FOUND',
      r.status === 404 && r.json.code === 'ROLL_NOT_FOUND', r.json);
    // 登记一个 BATCH-001 不可行（无放行），改用：让其它批次无卷即可。
    // 构造“卷不属于批次”：把 LABEL-0002 放到 BATCH-001 的出货单
    r = await api('POST', '/api/shipments', {
      batch_id: b1.id, ship_qty: 5, shipped_by: 'x', allocations: [{ roll_id: roll2Id, qty: 5 }]
    });
    check('卷不属于批次 → 400 ROLL_BATCH_MISMATCH',
      r.status === 400 && r.json.code === 'ROLL_BATCH_MISMATCH', r.json);
    for (const q of [0, -2, 1.5, 'x']) {
      r = await api('POST', '/api/shipments', {
        batch_id: b3.id, ship_qty: 1, shipped_by: 'x',
        allocations: [{ roll_id: roll2Id, qty: q === 'x' ? 'abc' : q }]
      });
      check(`分配张数 ${JSON.stringify(q)} → 400 INVALID_REQUEST`,
        r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    }

    // ---------- 7. 整单拒绝：分配和 ≠ 出货量 ----------
    console.log('7) 分配总数不等于出货量 → 400 ALLOCATION_MISMATCH');
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 11, shipped_by: 'x',
      allocations: [{ roll_id: roll2Id, qty: 10 }]
    });
    check('少 1 张 → 400 ALLOCATION_MISMATCH',
      r.status === 400 && r.json.code === 'ALLOCATION_MISMATCH', r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 9, shipped_by: 'x',
      allocations: [{ roll_id: roll2Id, qty: 10 }]
    });
    check('多 1 张 → 400 ALLOCATION_MISMATCH',
      r.status === 400 && r.json.code === 'ALLOCATION_MISMATCH', r.json);

    // ---------- 8. 整单拒绝：累计超已贴 ----------
    console.log('8) 每卷累计已分配不得超过已贴用 → 409 OVER_APPLIED');
    // LABEL-0002 已贴 50，已分配 10，余额 40。申请 41 必失败。
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 41, shipped_by: 'x',
      allocations: [{ roll_id: roll2Id, qty: 41 }]
    });
    check('超已贴 → 409 OVER_APPLIED',
      r.status === 409 && r.json.code === 'OVER_APPLIED', r.json);
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    check('被拒后余额不变（仍 40）', r.json.shippable_qty === 40, r.json);

    // ---------- 9. 多卷单一失败整单回滚、不占数量 ----------
    console.log('9) 多卷分配其中一卷超量 → 整单拒绝、两卷都不占用');
    const before = (await api('GET', `/api/batches/${b3.id}/shipment-balance`)).json;
    const before2 = before.rolls.find((x) => x.roll_code === 'LABEL-0002').allocated_qty;
    // 先给 LABEL-0001 补货贴用 30（其当前可出货 0），让两卷都有余额
    r = await api('POST', `/api/label-rolls/${demoRoll.id}/consume`,
      { expected_revision: 2, applied: 30, voided: 0 });
    check('演示卷再贴 30（rev→3）', r.status === 200 && r.json.revision === 3, r.json);
    // 第二卷申请 9999（超量），即便第一卷 5 合法也整体拒绝
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 10004, shipped_by: 'x',
      allocations: [
        { roll_id: demoRoll.id, qty: 5 },
        { roll_id: roll2Id, qty: 9999 }
      ]
    });
    check('整单 409 OVER_APPLIED', r.status === 409 && r.json.code === 'OVER_APPLIED', r.json);
    const after = (await api('GET', `/api/batches/${b3.id}/shipment-balance`)).json;
    const after2 = after.rolls.find((x) => x.roll_code === 'LABEL-0002').allocated_qty;
    check('回滚后 LABEL-0002 累计已分配不变', after2 === before2, { before2, after2 });
    const after1 = after.rolls.find((x) => x.roll_code === 'LABEL-0001');
    check('回滚后 LABEL-0001 可出货仍为 30（150 贴 - 120 分）',
      after1.applied_qty === 150 && after1.allocated_qty === 120 && after1.available_qty === 30, after1);

    // ---------- 10. 原料/事件变更使卷停用 → 已出货单待评估 ----------
    console.log('10) 事件更正使集合改变：相关已出货单标记 PENDING_REVIEW 且给原因');
    const e3full = {
      type: 'PROCESS', event_time: e3.event_time, equipment_id: e3.equipment_id,
      note: e3.note, batch_code: e3.batch_code,
      material_ids: e3.inputs.filter((i) => i.material_id).map((i) => i.material_id).concat(peanut),
      ref_batch_ids: e3.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    };
    r = await api('PUT', `/api/events/${e3.id}`, e3full);
    check('事件更正 200', r.status === 200, r);
    check('响应含 pending_shipments',
      Array.isArray(r.json.pending_shipments) && r.json.pending_shipments.length === 2,
      r.json.pending_shipments);
    let st = (await api('GET', '/api/state')).json;
    for (const code of ['SHIP-0001', 'SHIP-0002']) {
      const sh = st.shipments.find((x) => x.shipment_code === code);
      check(`${code} PENDING_REVIEW`, sh.status === 'PENDING_REVIEW', sh);
      check(`${code} 原因非空且点名卷`,
        sh.review_reason.includes('LABEL-') && sh.review_reason.length > 10, sh.review_reason);
      check(`${code} 明细与数量仍在（记录不消失）`,
        sh.items.length >= 1 && sh.allocated_qty === sh.ship_qty, sh.items.length);
    }
    r = await api('GET', '/api/shipments/SHIP-0001');
    check('按单号查询待评估单 200',
      r.status === 200 && r.json.status === 'PENDING_REVIEW' && r.json.pending_review === true, r.json);
    r = await api('GET', '/api/shipments?status=PENDING_REVIEW');
    check('按状态过滤返回 2 张待评估', r.status === 200 && r.json.length === 2, r.json);
    r = await api('GET', '/api/shipments?status=SHIPPED');
    check('已出货过滤为空', r.status === 200 && r.json.length === 0, r.json);
    r = await api('GET', '/api/shipments/9999');
    check('不存在出货单 → 404 SHIPMENT_NOT_FOUND',
      r.status === 404 && r.json.code === 'SHIPMENT_NOT_FOUND', r.json);

    // ---------- 11. 停卷尚未分配的已贴张数不得再出货 ----------
    console.log('11) 停卷未分配的已贴张数不可再出货');
    r = await api('GET', `/api/batches/${b3.id}/shipment-balance`);
    check('两卷均 RETIRED，批次可出货余额 0',
      r.json.rolls.every((x) => x.status === 'RETIRED') && r.json.shippable_qty === 0, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 1, shipped_by: 'x',
      allocations: [{ roll_id: demoRoll.id, qty: 1 }]
    });
    check('用停用卷出货 → 409 ROLL_RETIRED',
      r.status === 409 && r.json.code === 'ROLL_RETIRED', r.json);

    // ---------- 12. 撤销更正使集合恢复，不自动恢复 ----------
    console.log('12) 集合恢复后出货单不自动恢复（终态），新放行下可继续出货');
    const e3back = {
      ...e3full,
      material_ids: e3.inputs.filter((i) => i.material_id).map((i) => i.material_id)
    };
    r = await api('PUT', `/api/events/${e3.id}`, e3back);
    check('回退更正 200', r.status === 200, r);
    st = (await api('GET', '/api/state')).json;
    check('SHIP-0001/0002 仍 PENDING_REVIEW（不自动恢复）',
      st.shipments.filter((x) => x.status === 'PENDING_REVIEW').length === 2, st.shipments);
    // 旧卷也仍停用，需要新放行 + 新卷
    r = await api('POST', '/api/releases',
      { batch_id: b3.id, released_at: D + '16:00', released_by: '复核员' });
    const newRelId = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: newRelId, allergens: set3, print_qty: 200
    });
    const newRollId = r.json.id;
    check('新卷登记成功', r.status === 200, r.json);
    r = await api('POST', `/api/label-rolls/${newRollId}/consume`,
      { expected_revision: 0, applied: 60, voided: 0 });
    check('新卷贴用 60', r.status === 200, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 60, shipped_by: '新人',
      allocations: [{ roll_id: newRollId, qty: 60 }]
    });
    check('新卷出货 60 成功 → SHIP-0003 SHIPPED',
      r.status === 200 && r.json.shipment_code === 'SHIP-0003' && r.json.status === 'SHIPPED',
      r.json);
    check('新单保存新放行标识',
      r.json.items[0].release_id === newRelId && r.json.items[0].roll_revision === 1,
      r.json.items[0]);

    // ---------- 13. 放行删除 → 新卷停用、新单待评估；旧记录不消失 ----------
    console.log('13) 删除放行：名下卷停用、相关出货单待评估；旧出货单的放行快照仍保留');
    r = await api('DELETE', `/api/releases/${newRelId}`);
    check('删除放行 200', r.status === 200, r);
    check('删除响应含 pending_shipments（SHIP-0003）',
      r.json.pending_shipments.some((x) => x.shipment_code === 'SHIP-0003'),
      r.json.pending_shipments);
    r = await api('GET', '/api/shipments/SHIP-0003');
    check('SHIP-0003 待评估，但明细仍保存当时放行标识/时间/人',
      r.json.status === 'PENDING_REVIEW' &&
      r.json.items[0].release_id === newRelId &&
      r.json.items[0].release_at === D + '16:00' &&
      r.json.items[0].release_by === '复核员',
      r.json);
    r = await api('GET', '/api/shipments?batch_id=' + b3.id);
    check('按批次过滤返回全部 3 张单（记录不因更正/删除消失）',
      r.status === 200 && r.json.length === 3, r.json);

    // ---------- 14. 整组换线：预演预测待评估、应用实际置位、影子库隔离 ----------
    console.log('14) 整组换线预演预测待评估出货单，且不改动正式库');
    // 再准备：新放行 + 新卷 + 贴用 + 出货（此时 SHIPPED）
    r = await api('POST', '/api/releases',
      { batch_id: b3.id, released_at: D + '16:30', released_by: '复核员2' });
    const relPreviewId = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: relPreviewId, allergens: set3, print_qty: 100
    });
    const previewRollId = r.json.id;
    r = await api('POST', `/api/label-rolls/${previewRollId}/consume`,
      { expected_revision: 0, applied: 40, voided: 0 });
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 40, shipped_by: 'x',
      allocations: [{ roll_id: previewRollId, qty: 40 }]
    });
    const previewShipCode = r.json.shipment_code;
    check('准备换线用 SHIPPED 单成功', r.status === 200, r.json);

    st = (await api('GET', '/api/state')).json;
    const e1 = st.events.find((x) => x.batch_code === 'BATCH-001');
    const swapChanges = [
      {
        op: 'update', event_id: e1.id, type: 'PROCESS',
        event_time: D + '09:00', equipment_id: e1.equipment_id, note: e1.note,
        batch_code: 'BATCH-001',
        material_ids: e1.inputs.filter((i) => i.material_id).map((i) => i.material_id),
        ref_batch_ids: []
      },
      {
        op: 'update',
        event_id: st.events.find((x) => x.type === 'CLEAN' && x.event_time === D + '09:00').id,
        type: 'CLEAN', event_time: D + '08:00', equipment_id: e1.equipment_id,
        note: '换线前已核实清洗'
      }
    ];
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('预演 200', r.status === 200, r);
    const firstVersion = r.json.version;
    check('预演差异含 shipments_will_pending',
      r.json.diff.summary.shipments_will_pending >= 1 &&
      r.json.diff.shipments_will_pending.some((x) => x.shipment_code === previewShipCode),
      r.json.diff);
    st = (await api('GET', '/api/state')).json;
    check('预演后正式单仍 SHIPPED（隔离）',
      st.shipments.find((x) => x.shipment_code === previewShipCode).status === 'SHIPPED',
      st.shipments);

    // 预演后发生一次正式出货（纳入指纹），旧预演版本应过期
    r = await api('POST', `/api/label-rolls/${previewRollId}/consume`,
      { expected_revision: 1, applied: 10, voided: 0 });
    check('再贴 10（rev→2）', r.status === 200 && r.json.revision === 2, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 10, shipped_by: 'x',
      allocations: [{ roll_id: previewRollId, qty: 10 }]
    });
    check('出货 10 成功（指纹前进）', r.status === 200, r.json);
    r = await api('POST', '/api/replan/apply', { version: firstVersion, changes: swapChanges });
    check('用旧版本应用 → 409 VERSION_EXPIRED，原状态不变',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    st = (await api('GET', '/api/state')).json;
    check('过期被拒后预告单仍 SHIPPED',
      st.shipments.find((x) => x.shipment_code === previewShipCode).status === 'SHIPPED',
      st.shipments);

    // 重新预演后确认应用
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('重新预演 200', r.status === 200, r);
    r = await api('POST', '/api/replan/apply', { version: r.json.version, changes: swapChanges });
    check('应用 200', r.status === 200, r);
    check('应用响应 pending_shipments 含预告单',
      r.json.pending_shipments.some((x) => x.shipment_code === previewShipCode),
      r.json.pending_shipments);
    st = (await api('GET', '/api/state')).json;
    check('正式库预告单已 PENDING_REVIEW',
      st.shipments.find((x) => x.shipment_code === previewShipCode).status === 'PENDING_REVIEW',
      st.shipments);
    check('其明细修订号（出货当时为 1）/放行标识快照仍可查',
      st.shipments.find((x) => x.shipment_code === previewShipCode).items[0].roll_revision === 1 &&
      st.shipments.find((x) => x.shipment_code === previewShipCode).items[0].release_id === relPreviewId,
      st.shipments.find((x) => x.shipment_code === previewShipCode).items[0]);

  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  if (failures) {
    console.error(`\n失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
