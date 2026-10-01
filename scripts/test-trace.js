'use strict';
// 供应批号追溯：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   1) 旧写入 material_ids 仍可用，其输入记作“批号未知”，旧记录不丢失（/api/state 可查）；
//   2) material_inputs 新写入：同料多批号/批号未知；混用两种写法被拒绝；
//   3) 追溯三渠道传播：直接投料、前序批次引用、同设备未清洗残留逐时传播；
//   4) 已核实清洗截断设备残留（PEANUT 仅到 BATCH-004）；
//   5) 确定命中（CONFIRMED）与“批号未知无法排除”（POSSIBLE）分别返回，不降级/不漏报；
//   6) 批号不存在 404、与原料不匹配 400、参数缺失 400、原料不存在 404；
//   7) 事件更正/删除后按最新时间线更新（POSSIBLE 升级 CONFIRMED、删除后消失）；
//   8) 关联出货单（SHIP-0001）随 BATCH-003 命中列出；路径限量不影响对象集合；
//   9) 整组换线（replan）对 material_inputs 往返与应用；
//  10) 追溯只读：不改变放行、标签卷、出货、处置结论。
//   node scripts/test-trace.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39131';
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

function codes(list, key = 'batch_code') { return (list || []).map((x) => x[key]); }

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
    const mid = (code) => state0.materials.find((m) => m.code === code).id;
    const MILK = mid('MILK-01'), PEANUT = mid('PEANUT-01'), EGG = mid('EGG-01');
    const byCode = (code) => state0.batches.find((b) => b.code === code);
    const evOf = (code) => state0.events.find((e) => e.batch_code === code);
    const TRACE = (mc, lot, extra = '') =>
      api('GET', `/api/trace?material_code=${encodeURIComponent(mc)}&supplier_lot=${encodeURIComponent(lot)}${extra}`);

    // ---------- 1. 演示数据：逐次投料登记了供应批号 ----------
    console.log('1) 演示数据的原料输入带供应批号（同料多批号/未知）');
    const e1Inputs = evOf('BATCH-001').inputs.filter((i) => i.material_id === mid('WHEAT-01'));
    check('BATCH-001 小麦两个批号',
      e1Inputs.length === 2 && e1Inputs.every((i) => i.lot_known) &&
      e1Inputs.some((i) => i.supplier_lot === 'WHT-20260920-A') &&
      e1Inputs.some((i) => i.supplier_lot === 'WHT-20260925-A'), e1Inputs);
    const saltUnknown = evOf('BATCH-001').inputs.find((i) => i.material_code === 'SALT-01');
    check('未登记批号的原料 lot_known=false（批号未知）', saltUnknown && saltUnknown.lot_known === false);

    // ---------- 2. 批号清单接口 ----------
    console.log('2) 原料名下供应批号清单');
    let r = await api('GET', '/api/materials/MILK-01/supplier-lots');
    check('牛奶批号清单含 MLK-20260928-A',
      r.status === 200 && r.json.lots.some((l) => l.supplier_lot === 'MLK-20260928-A'), r.json);
    check('另有 1 条批号未知投料', r.json.unknown_lot_input_count === 1, r.json);
    r = await api('GET', '/api/materials/NOPE-99/supplier-lots');
    check('未知原料批号清单 → 404', r.status === 404 && r.json.code === 'MATERIAL_NOT_FOUND', r.json);

    // ---------- 3. 三渠道传播：牛奶批号 ----------
    console.log('3) MLK-20260928-A：直接投料→BATCH-002；引用+未清洗残留→BATCH-003；未知批号链路 POSSIBLE');
    r = await TRACE('MILK-01', 'MLK-20260928-A');
    check('200', r.status === 200, r.json);
    check('确定命中 002、003',
      JSON.stringify(codes(r.json.confirmed_batches).sort()) === JSON.stringify(['BATCH-002', 'BATCH-003']),
      codes(r.json.confirmed_batches));
    check('无法排除 006、007（演示夜班未知批号链）',
      JSON.stringify(codes(r.json.possible_batches).sort()) === JSON.stringify(['BATCH-DEMO-U1', 'BATCH-DEMO-U2']),
      codes(r.json.possible_batches));
    const b3 = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-003');
    check('BATCH-003 依据含前序引用与设备残留',
      b3.basis.via_refs.some((x) => x.batch_code === 'BATCH-002') &&
      b3.basis.via_residue.some((x) => x.batch_code === 'BATCH-002' && x.equipment_code === 'LINE-A'),
      b3.basis);
    check('BATCH-003 路径链可读（引用/残留两种）',
      b3.paths.length >= 2 && b3.paths.some((p) => p.path.includes('未清洗残留')),
      b3.paths.map((p) => p.path));
    const b7 = r.json.possible_batches.find((x) => x.batch_code === 'BATCH-DEMO-U2');
    check('BATCH-DEMO-U2（引用+残留）也无法排除',
      b7.basis.via_refs.some((x) => x.batch_code === 'BATCH-DEMO-U1') &&
      b7.basis.via_residue.some((x) => x.batch_code === 'BATCH-DEMO-U1'), b7.basis);
    check('关联出货单 SHIP-0001（经 BATCH-003）',
      r.json.affected_shipments.some((s) => s.shipment_code === 'SHIP-0001' &&
        s.matched_via.includes('BATCH-003') && s.status === 'SHIPPED'), r.json.affected_shipments);

    // ---------- 4. 已核实清洗截断残留 ----------
    console.log('4) PEANUT 批号：13:00 已核实清洗截断 → 仅 BATCH-004，BATCH-005 不命中');
    r = await TRACE('PEANUT-01', 'PNT-20260925-X');
    check('仅确定命中 BATCH-004',
      codes(r.json.confirmed_batches).length === 1 && codes(r.json.confirmed_batches)[0] === 'BATCH-004',
      codes(r.json.confirmed_batches));
    check('BATCH-005 既不确定也不无法排除',
      !codes(r.json.possible_batches).includes('BATCH-005'), codes(r.json.possible_batches));
    check('无关联出货单', r.json.summary.affected_shipment_count === 0);

    // 小麦：09:00 LINE-A 清洗后，BATCH-002/003 不应带小麦残留
    r = await TRACE('WHEAT-01', 'WHT-20260920-A');
    check('小麦批号被 09:00 清洗截断（仅 BATCH-001）',
      JSON.stringify(codes(r.json.confirmed_batches)) === JSON.stringify(['BATCH-001']),
      codes(r.json.confirmed_batches));

    // ---------- 5. 确定优先于未知：同批既有目标批号又有未知批号 → CONFIRMED ----------
    console.log('5) 同批同时投入目标批号与批号未知 → 确定命中（未知不降级）');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-09-30T18:00', equipment_id: 2,
      batch_code: 'BATCH-MIXED-LOT',
      material_inputs: [
        { material_id: MILK, supplier_lot: 'MLK-20260928-A' },
        { material_id: MILK } // 批号未知
      ]
    });
    check('写入成功', r.status === 200, r.json);
    r = await TRACE('MILK-01', 'MLK-20260928-A');
    check('BATCH-MIXED-LOT 为 CONFIRMED',
      r.json.confirmed_batches.some((x) => x.batch_code === 'BATCH-MIXED-LOT') &&
      !r.json.possible_batches.some((x) => x.batch_code === 'BATCH-MIXED-LOT'),
      { c: codes(r.json.confirmed_batches), p: codes(r.json.possible_batches) });

    // ---------- 6. 旧写法 material_ids 仍可用 = 批号未知 ----------
    console.log('6) 旧写入 material_ids 兼容（记作批号未知，旧记录不丢失）');
    // 先对 FRYER-B 追加一次已核实清洗，切断 18:00 混合批的残留，确保“无法排除”仅来自批号未知本身。
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-09-30T18:15', equipment_id: 2, note: '追溯测试前清洗'
    });
    check('测试前清洗成功', r.status === 200, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-09-30T18:30', equipment_id: 2,
      batch_code: 'BATCH-LEGACY', material_ids: [MILK]
    });
    check('旧写法 200', r.status === 200, r.json);
    const st = (await api('GET', '/api/state')).json;
    const legInputs = st.events.find((e) => e.batch_code === 'BATCH-LEGACY').inputs;
    check('旧写法输入 lot_known=false 且记录保留',
      legInputs.length === 1 && legInputs[0].material_id === MILK && legInputs[0].lot_known === false, legInputs);
    // FRYER-B 13:00 清洗过，18:30 投入未知牛奶：批号 MLK 对该批只能“无法排除”
    r = await TRACE('MILK-01', 'MLK-20260928-A');
    check('旧写法批次列为 POSSIBLE 而非 CONFIRMED',
      r.json.possible_batches.some((x) => x.batch_code === 'BATCH-LEGACY') &&
      !r.json.confirmed_batches.some((x) => x.batch_code === 'BATCH-LEGACY'),
      { c: codes(r.json.confirmed_batches), p: codes(r.json.possible_batches) });

    // ---------- 7. 混用两种写法 / 非法 material_inputs 拒绝 ----------
    console.log('7) material_inputs 与 material_ids 混用拒绝；非法元素拒绝');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-09-30T19:00', equipment_id: 2, batch_code: 'BATCH-BAD',
      material_ids: [MILK], material_inputs: [{ material_id: MILK, supplier_lot: 'X' }]
    });
    check('混用 → 400', r.status === 400, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-09-30T19:00', equipment_id: 2, batch_code: 'BATCH-BAD2',
      material_inputs: [{ supplier_lot: 'X' }]
    });
    check('缺 material_id → 400', r.status === 400, r.json);

    // ---------- 8. 错误批号/原料语义 ----------
    console.log('8) 批号不存在/不匹配/参数缺失');
    r = await TRACE('EGG-01', 'NEVER-EXIST');
    check('全库不存在批号 → 404 SUPPLIER_LOT_NOT_FOUND',
      r.status === 404 && r.json.code === 'SUPPLIER_LOT_NOT_FOUND', r.json);
    r = await TRACE('WHEAT-01', 'MLK-20260928-A');
    check('批号属于其它原料 → 400 SUPPLIER_LOT_MISMATCH（附归属原料）',
      r.status === 400 && r.json.code === 'SUPPLIER_LOT_MISMATCH' &&
      r.json.details.some((d) => d.material_code === 'MILK-01'), r.json);
    r = await api('GET', '/api/trace?material_code=MILK-01');
    check('缺批号 → 400 INVALID_REQUEST', r.status === 400, r.json);
    r = await api('GET', '/api/trace?supplier_lot=X');
    check('缺原料 → 400', r.status === 400, r.json);
    r = await TRACE('NOPE', 'X');
    check('原料不存在 → 404 MATERIAL_NOT_FOUND',
      r.status === 404 && r.json.code === 'MATERIAL_NOT_FOUND', r.json);

    // ---------- 9. 更正：POSSIBLE 升级为 CONFIRMED；删除：结果更新 ----------
    console.log('9) 事件更正/删除后按最新合法时间线更新');
    const legacyId = (await api('GET', '/api/state')).json.events
      .find((e) => e.batch_code === 'BATCH-LEGACY').id;
    r = await api('PUT', `/api/events/${legacyId}`, {
      type: 'PROCESS', event_time: '2026-09-30T18:30', equipment_id: 2,
      batch_code: 'BATCH-LEGACY',
      material_inputs: [{ material_id: MILK, supplier_lot: 'MLK-20260928-A' }]
    });
    check('更正成功', r.status === 200 && r.json.ok, r.json);
    r = await TRACE('MILK-01', 'MLK-20260928-A');
    check('更正后 BATCH-LEGACY 升为 CONFIRMED',
      r.json.confirmed_batches.some((x) => x.batch_code === 'BATCH-LEGACY'), codes(r.json.confirmed_batches));
    check('POSSIBLE 中已无 BATCH-LEGACY',
      !r.json.possible_batches.some((x) => x.batch_code === 'BATCH-LEGACY'), codes(r.json.possible_batches));

    const mixedId = (await api('GET', '/api/state')).json.events
      .find((e) => e.batch_code === 'BATCH-MIXED-LOT').id;
    r = await api('DELETE', `/api/events/${mixedId}`);
    check('删除成功', r.status === 200 && r.json.ok, r.json);
    r = await TRACE('MILK-01', 'MLK-20260928-A');
    check('删除后结果不再含 BATCH-MIXED-LOT',
      !codes(r.json.confirmed_batches).includes('BATCH-MIXED-LOT') &&
      !codes(r.json.possible_batches).includes('BATCH-MIXED-LOT'));

    // ---------- 10. 路径限量：max_paths=1 仍列全对象 ----------
    console.log('10) max_paths 仅限制路径展示，不影响受影响对象');
    r = await TRACE('MILK-01', 'MLK-20260928-A', '&max_paths=1');
    check('max_paths=1 时 BATCH-003 仍在命中集合',
      r.json.confirmed_batches.some((x) => x.batch_code === 'BATCH-003'));
    const b3lim = r.json.confirmed_batches.find((x) => x.batch_code === 'BATCH-003');
    check('仅展示 1 条路径且标记截断（总路径数更多）',
      b3lim.paths_shown === 1 && b3lim.paths_truncated === true && b3lim.path_count_total > 1,
      { shown: b3lim.paths_shown, total: b3lim.path_count_total });
    check('非法 max_paths → 400',
      (await TRACE('MILK-01', 'MLK-20260928-A', '&max_paths=0')).status === 400);

    // ---------- 11. 整组换线：material_inputs 预演往返 + 确认应用 ----------
    console.log('11) replan preview/apply 携带供应批号');
    const e3id = evOf('BATCH-002').id;
    r = await api('POST', '/api/replan/preview', {
      changes: [{
        op: 'update', event_id: e3id, type: 'PROCESS', event_time: '2026-09-30T10:00',
        equipment_id: 1, note: '蛋糕糊（追加一批号）', batch_code: 'BATCH-002',
        material_inputs: [
          { material_id: MILK, supplier_lot: 'MLK-20260928-A' },
          { material_id: MILK, supplier_lot: 'MLK-EXTRA' },
          { material_id: EGG, supplier_lot: 'EGG-20260928-B' }
        ],
        ref_batch_ids: []
      }]
    });
    check('预演成功且回显 material_inputs（含新批号）',
      r.status === 200 && r.json.ok &&
      r.json.changes[0].material_inputs.some((x) => x.supplier_lot === 'MLK-EXTRA'), r.json);
    const version = r.json.version;
    r = await api('POST', '/api/replan/apply', {
      version,
      changes: [{
        op: 'update', event_id: e3id, type: 'PROCESS', event_time: '2026-09-30T10:00',
        equipment_id: 1, note: '蛋糕糊（追加一批号）', batch_code: 'BATCH-002',
        material_inputs: [
          { material_id: MILK, supplier_lot: 'MLK-20260928-A' },
          { material_id: MILK, supplier_lot: 'MLK-EXTRA' },
          { material_id: EGG, supplier_lot: 'EGG-20260928-B' }
        ],
        ref_batch_ids: []
      }]
    });
    check('应用成功', r.status === 200 && r.json.ok, r.json);
    r = await TRACE('MILK-01', 'MLK-EXTRA');
    check('新批号 MLK-EXTRA 经应用后可追溯（002→003）',
      codes(r.json.confirmed_batches).includes('BATCH-002') &&
      codes(r.json.confirmed_batches).includes('BATCH-003'), codes(r.json.confirmed_batches));

    // ---------- 12. 追溯只读，不改变放行/出货 ----------
    console.log('12) 追溯只读：放行/标签卷/出货结论不被追溯改变');
    const after = (await api('GET', '/api/state')).json;
    const ship = after.shipments.find((s) => s.shipment_code === 'SHIP-0001');
    check('SHIP-0001 仍为 SHIPPED（追溯不改其状态）', ship.status === 'SHIPPED', ship.status);
    const b3State = after.batches.find((b) => b.code === 'BATCH-003');
    check('BATCH-003 放行记录未被追溯改写',
      Array.isArray(b3State.releases) && b3State.releases.length >= 1);

    // ---------- 13. 全新批号（跨设备多跳残留传播不漏报） ----------
    console.log('13) 跨小时同设备残留逐时传播（自定义新批号链路）');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: 1,
      batch_code: 'BATCH-T1',
      material_inputs: [{ material_id: PEANUT, supplier_lot: 'PNT-CHAIN' }]
    });
    check('T1 写入', r.status === 200, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: 1,
      batch_code: 'BATCH-T2', material_inputs: [{ material_id: mid('SALT-01') }]
    });
    check('T2 写入（无花生投料）', r.status === 200, r.json);
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T10:00', equipment_id: 1,
      batch_code: 'BATCH-T3', material_inputs: [{ material_id: mid('SALT-01') }],
      ref_batch_ids: []
    });
    check('T3 写入', r.status === 200, r.json);
    r = await TRACE('PEANUT-01', 'PNT-CHAIN');
    check('T1 确定、T2/T3 经未清洗残留逐时确定命中（无清洗截断）',
      JSON.stringify(codes(r.json.confirmed_batches).filter((c) => c.startsWith('BATCH-T')).sort())
        === JSON.stringify(['BATCH-T1', 'BATCH-T2', 'BATCH-T3']),
      codes(r.json.confirmed_batches));
    // 中途清洗后新增 T4：不应再命中
    await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T10:30', equipment_id: 1, note: '追溯测试清洗'
    });
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T11:00', equipment_id: 1,
      batch_code: 'BATCH-T4', material_inputs: [{ material_id: mid('SALT-01') }]
    });
    check('T4 写入（清洗后）', r.status === 200, r.json);
    r = await TRACE('PEANUT-01', 'PNT-CHAIN');
    check('清洗截断：T4 不命中', !codes(r.json.confirmed_batches).includes('BATCH-T4'),
      codes(r.json.confirmed_batches));

  } finally {
    proc.kill();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
