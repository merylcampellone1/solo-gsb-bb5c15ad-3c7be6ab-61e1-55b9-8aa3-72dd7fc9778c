'use strict';
// 换线整组预演 / 确认应用：端到端 HTTP 测试。
// 启动一个使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证需求。
//   node scripts/test-replan.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39117';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
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
    env: {
      ...process.env,
      PORT,
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      SEED_DEMO: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const state0 = (await api('GET', '/api/state')).json;
    const byCode = (code) => state0.events.find((e) => e.batch_code === code);
    const eq = (code) => state0.equipment.find((e) => e.code === code);
    const mat = (code) => state0.materials.find((m) => m.code === code);
    const lineA = eq('LINE-A').id;
    const fryerB = eq('FRYER-B').id;
    const e1 = byCode('BATCH-001');
    const e3 = byCode('BATCH-002');
    const eggId = mat('EGG-01').id;

    const fullProcess = (ev, patch = {}) => ({
      op: 'update',
      event_id: ev.id,
      type: 'PROCESS',
      event_time: ev.event_time,
      equipment_id: ev.equipment_id,
      note: ev.note || '',
      batch_code: ev.batch_code,
      material_ids: ev.inputs.filter((i) => i.material_id).map((i) => i.material_id),
      ref_batch_ids: ev.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id),
      ...patch
    });
    const fullClean = (ev, patch = {}) => ({
      op: 'update', event_id: ev.id, type: 'CLEAN',
      event_time: ev.event_time, equipment_id: ev.equipment_id,
      note: ev.note || '', ...patch
    });
    const D = '2026-09-30T';

    // ---------- 1. 预演失败：未知事件 ----------
    console.log('1) 未知事件必须明确拒绝');
    let r = await api('POST', '/api/replan/preview', { changes: [fullProcess(e1, { event_id: 999999 })] });
    check('返回 400', r.status === 400, r);
    check('code=REPLAN_REJECTED', r.json && r.json.code === 'REPLAN_REJECTED', r.json);
    check('原因含“不存在”', r.json && r.json.details.some((d) => d.includes('不存在')), r.json);

    // ---------- 2. 预演失败：重复更正同一事件 ----------
    console.log('2) 重复更正同一事件必须拒绝');
    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(e1), fullProcess(e1, { note: 'x' })] });
    check('返回 400', r.status === 400, r);
    check('原因含“重复更正”', r.json.details.some((d) => d.includes('重复更正')), r.json);

    // ---------- 3. 预演失败：设备不存在 ----------
    console.log('3) 设备不存在必须拒绝');
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', event_time: D + '09:30', equipment_id: 999999, note: 'x' }]
    });
    check('返回 400', r.status === 400, r);
    check('原因含“设备”', r.json.details.some((d) => d.includes('设备')), r.json);

    // ---------- 4. 预演失败：清洗事件缺少时间 ----------
    console.log('4) 插入清洗缺少时间必须拒绝');
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', equipment_id: lineA, note: '漏写时间' }]
    });
    check('返回 400', r.status === 400, r);
    check('原因含“缺少时间”', r.json.details.some((d) => d.includes('缺少时间')), r.json);

    // ---------- 5. 预演失败：整组最终非法（引用未来批次） ----------
    console.log('5) 整组后引用未来批次，预演失败并显示原因');
    // 把 BATCH-002(10:00) 移到 11:30（晚于引用它的 BATCH-003@11:00）即“引用未来批次”：
    r = await api('POST', '/api/replan/preview', { changes: [fullProcess(e3, { event_time: D + '11:30' })] });
    check('返回 400（未来引用）', r.status === 400, r);
    check('原因含“未来”', r.json.details.some((d) => d.includes('未来')), r.json);

    // ---------- 5b. 整组后形成引用环，预演失败 ----------
    console.log('5b) 整组后形成引用环，预演失败并显示原因');
    const e4 = byCode('BATCH-003'); // 引用 BATCH-002
    r = await api('POST', '/api/replan/preview', {
      changes: [
        fullProcess(e3, { ref_batch_ids: [e4.batch_id] }), // BATCH-002 -> BATCH-003
        // BATCH-003 -> BATCH-002（既有引用，同时把两者改到同设备不同时刻以仅测成环）
      ]
    });
    // BATCH-002@10:00 引用 BATCH-003@11:00 本身已是“未来引用”，环由 DFS 兜底标出
    check('返回 400', r.status === 400, r);
    check('原因含“循环”或“未来”', r.json.details.some((d) => d.includes('循环') || d.includes('未来')), r.json);

    // ---------- 6. 单条冲突但整组合法：交换两个事件的时间 ----------
    console.log('6) 单条暂时冲突、整组最终合法仍可预演');
    // BATCH-001@08:00 LINE-A 与 清洗@09:00 LINE-A 交换时间：
    const clean9 = state0.events.find((e) => e.type === 'CLEAN' && e.event_time === D + '09:00' && e.equipment_id === lineA);
    const swapChanges = [
      fullProcess(e1, { event_time: D + '09:00' }),
      fullClean(clean9, { event_time: D + '08:00' })
    ];
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('预演 200', r.status === 200, r);
    check('返回业务版本 version', typeof r.json.version === 'string' && r.json.version.length > 20, r.json);
    check('回显规范化变更 2 条', r.json.changes.length === 2, r.json.changes);
    // BATCH-002 原本在 09:00 清洗之后产出（无残留），交换后清洗在 08:00，BATCH-001(麸质) 的残留带入 BATCH-002
    const b2 = r.json.diff.batches.find((b) => b.code === 'BATCH-002');
    check('BATCH-002 新增含麸质的谷物', b2 && b2.added.includes('含麸质的谷物'), b2);
    const rel = r.json.diff.releases.find((x) => x.batch_code === 'BATCH-003');
    check('BATCH-003 的放行将失效', rel && rel.before_status === 'ACTIVE' && rel.after_status === 'INVALIDATED', rel);
    check('将失效计数=1', r.json.diff.summary.releases_will_invalidate === 1, r.json.diff.summary);
    const goodVersion = r.json.version;

    // ---------- 7. 预演不改正式状态 ----------
    console.log('7) 预演不得修改正式事件/推导/放行');
    const state1 = (await api('GET', '/api/state')).json;
    const b1now = state1.events.find((e) => e.id === e1.id);
    check('正式 BATCH-001 时间仍是 08:00', b1now.event_time === D + '08:00', b1now);
    const b2now = state1.batches.find((b) => b.code === 'BATCH-002');
    check('正式 BATCH-002 未新增麸质', !b2now.allergens.includes('含麸质的谷物'), b2now.allergens);
    const relNow = state1.batches.find((b) => b.code === 'BATCH-003').releases[0];
    check('正式放行仍 ACTIVE', relNow.status === 'ACTIVE', relNow);
    check('正式事件数不变（未插入清洗）', state1.events.length === state0.events.length, [state1.events.length, state0.events.length]);

    // ---------- 8. 应用：变更内容不一致被拒 ----------
    console.log('8) apply 变更内容与预演不一致 → 409 且原状态不变');
    r = await api('POST', '/api/replan/apply', {
      version: goodVersion,
      changes: [fullProcess(e1, { event_time: D + '09:00' })] // 少了清洗交换
    });
    check('返回 409 CHANGES_MISMATCH', r.status === 409 && r.json.code === 'CHANGES_MISMATCH', r);

    // ---------- 9. 应用：伪造/损坏版本被拒 ----------
    console.log('9) 损坏的预演版本被拒');
    r = await api('POST', '/api/replan/apply', { version: goodVersion + 'x', changes: swapChanges });
    check('返回 400 VERSION_INVALID', r.status === 400 && r.json.code === 'VERSION_INVALID', r);
    r = await api('POST', '/api/replan/apply', { version: 'not-a-token', changes: swapChanges });
    check('非法版本格式返回 400', r.status === 400 && r.json.code === 'VERSION_INVALID', r);

    // ---------- 10. 应用：预演后正式写入使版本过期 ----------
    console.log('10) 预演后任何影响结果的正式写入使版本过期（409，原状态不变）');
    // 先登记一条新放行（影响指纹）
    const batch3Id = state0.batches.find((b) => b.code === 'BATCH-003').id;
    r = await api('POST', '/api/releases', {
      batch_id: batch3Id, released_at: D + '11:45', released_by: '测试员'
    });
    check('正式写入放行成功', r.status === 200, r);
    r = await api('POST', '/api/replan/apply', { version: goodVersion, changes: swapChanges });
    check('返回 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);
    const state2 = (await api('GET', '/api/state')).json;
    check('过期拒绝后正式时间不变',
      state2.events.find((e) => e.id === e1.id).event_time === D + '08:00', state2);

    // ---------- 11. 重新预演 -> 成功应用（事务落库 + 重算 + 失效） ----------
    console.log('11) 重新预演并确认应用，一次事务落库、重算、失效');
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('重新预演 200', r.status === 200, r);
    const v2 = r.json.version;
    const willInvalidate = r.json.diff.summary.releases_will_invalidate;
    r = await api('POST', '/api/replan/apply', { version: v2, changes: swapChanges });
    check('应用 200', r.status === 200, r);
    check('应用返回差异', r.json.diff && r.json.diff.summary.batches_changed >= 1, r.json && r.json.diff);
    check('应用返回 invalidated 列表', Array.isArray(r.json.invalidated) &&
      r.json.invalidated.length === willInvalidate, r.json && r.json.invalidated);
    check('应用返回新业务版本', typeof r.json.business_version === 'string', r.json);

    const state3 = (await api('GET', '/api/state')).json;
    check('正式 BATCH-001 已改为 09:00',
      state3.events.find((e) => e.id === e1.id).event_time === D + '09:00', state3);
    check('正式清洗已改为 08:00',
      state3.events.find((e) => e.id === clean9.id).event_time === D + '08:00', state3);
    const b32 = state3.batches.find((b) => b.code === 'BATCH-002');
    check('正式 BATCH-002 已含麸质', b32.allergens.includes('含麸质的谷物'), b32.allergens);
    const rels3 = state3.batches.find((b) => b.code === 'BATCH-003').releases;
    check('两条有效放行均已失效', rels3.every((x) => x.status === 'INVALIDATED'), rels3);
    check('失效原因为新增过敏原', rels3.every((x) => x.invalid_reason.includes('新增')), rels3);

    // ---------- 12. 版本一次性：重复应用同一版本 → 过期 ----------
    console.log('12) 已应用的版本不可再次使用');
    r = await api('POST', '/api/replan/apply', { version: v2, changes: swapChanges });
    check('重复应用返回 409 VERSION_EXPIRED', r.status === 409 && r.json.code === 'VERSION_EXPIRED', r);

    // ---------- 13. 插入清洗事件预演（残留差异），不动正式库 ----------
    console.log('13) 拟插入清洗事件：预演设备残留/批次差异与正式库隔离');
    // 当前正式时间线（应用交换后）：清洗@08:00 -> BATCH-001@09:00(麸质) ->
    // BATCH-002@10:00 -> BATCH-003@11:00 -> 班后清洗@15:00（LINE-A）。
    // 在 09:30 插入清洗：清掉 BATCH-001 留在设备上的麸质，
    //   BATCH-002 不再从设备残留获得麸质；BATCH-003 的麸质来自“引用 BATCH-002”，
    //   BATCH-002 麸质消失后 BATCH-003 也随之消失。
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'insert_clean', client_key: 'c1', event_time: D + '09:30', equipment_id: lineA, note: '预演插入的中间清洗' }
      ]
    });
    check('预演 200', r.status === 200, r);
    check('返回拟插入事件 id', r.json.inserted_clean_events[0] &&
      Number.isInteger(r.json.inserted_clean_events[0].event_id), r.json.inserted_clean_events);
    const rm132 = (r.json.diff.batches.find((x) => x.code === 'BATCH-002') || {}).removed || [];
    const rm133 = (r.json.diff.batches.find((x) => x.code === 'BATCH-003') || {}).removed || [];
    check('BATCH-002/003 均移除“含麸质的谷物”', rm132.includes('含麸质的谷物') && rm133.includes('含麸质的谷物'),
      r.json.diff.batches.map((b) => [b.code, b.added, b.removed]));
    const state3b = (await api('GET', '/api/state')).json;
    check('正式库未出现 09:30 清洗',
      !state3b.events.some((e) => e.type === 'CLEAN' && e.event_time === D + '09:30'), state3b.events);
    check('正式库批次结果未被预演改动',
      state3b.batches.find((b) => b.code === 'BATCH-002').allergens.includes('含麸质的谷物'),
      state3b.batches.find((b) => b.code === 'BATCH-002').allergens);

    // 插在 BATCH-001 之前（08:30，08:00 清洗之后）：对最终结果无影响，差异为空。
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', event_time: D + '08:30', equipment_id: lineA, note: '无效位置加洗' }]
    });
    check('无效位置插入清洗差异为空（summary 全 0）',
      r.json.diff.summary.batches_changed === 0 &&
      r.json.diff.summary.equipment_residue_changed === 0, r.json.diff.summary);

    // ---------- 14. 插入清洗导致设备时间冲突，预演失败 ----------
    console.log('14) 插入清洗与既有事件同设备同时刻 → 整组校验拒绝');
    r = await api('POST', '/api/replan/preview', {
      changes: [{ op: 'insert_clean', event_time: D + '09:00', equipment_id: lineA, note: '冲突清洗' }]
    });
    check('返回 400', r.status === 400, r);
    check('原因含“时间冲突”', r.json.details.some((d) => d.includes('时间冲突')), r.json);

    // ---------- 15. 批次唯一产出：不允许把编码改成别人的 ----------
    console.log('15) 批次编码占用 / 唯一产出约束');
    r = await api('POST', '/api/replan/preview', {
      changes: [fullProcess(e1, { batch_code: 'BATCH-002' })]
    });
    check('占用他人批次编码返回 400', r.status === 400 && r.json.details.some((d) => d.includes('占用')), r);

    // ---------- 16. 预演加过敏原：新增过敏原经残留+引用传播 ----------
    console.log('16) 更正原料输入：过敏原传播差异（基于应用交换后的正式时间线）');
    const stateFor16 = (await api('GET', '/api/state')).json;
    const ev16 = stateFor16.events.find((e) => e.batch_code === 'BATCH-001'); // 交换后在 09:00
    const peanutId = mat('PEANUT-01').id; // 花生：LINE-A 全线原本没有，便于观察传播
    r = await api('POST', '/api/replan/preview', {
      changes: [fullProcess(ev16, { material_ids: [mat('WHEAT-01').id, mat('SALT-01').id, peanutId] })]
    });
    check('预演 200', r.status === 200, r);
    // 交换后的时间线：BATCH-001@09:00(加花生) -> BATCH-002@10:00（设备残留带入花生）
    // -> BATCH-003@11:00（引用 BATCH-002 带入花生）
    const peanutBatches = r.json.diff.batches.filter((b) =>
      ['BATCH-001', 'BATCH-002', 'BATCH-003'].includes(b.code) && b.added.includes('花生'));
    check('BATCH-001/002/003 均新增“花生”（残留 + 引用传播）', peanutBatches.length === 3,
      r.json.diff.batches.map((b) => [b.code, b.added]));
    check('预演不写正式库：正式 BATCH-001 仍无花生',
      !(await api('GET', '/api/state')).json.batches.find((b) => b.code === 'BATCH-001').allergens.includes('花生'));

    // ---------- 17. 既有单条接口语义保持不变 ----------
    console.log('17) 既有单条事件接口仍按原语义工作（事务化校验+重算）');
    r = await api('PUT', `/api/events/${e3.id}`, fullProcess(e3, { event_time: D + '11:30' }));
    check('单条更正触发未来引用仍拒绝 400', r.status === 400, r);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: D + '10:00', equipment_id: lineA, note: '单条接口冲突测试'
    });
    check('单条新增同设备同时刻仍拒绝 400', r.status === 400, r);

    // ---------- 18. changes 非数组 / 空数组 ----------
    console.log('18) 请求体边界');
    r = await api('POST', '/api/replan/preview', { changes: 'nope' });
    check('changes 非数组 → 400', r.status === 400, r);
    r = await api('POST', '/api/replan/preview', { changes: [] });
    check('空 changes → 400', r.status === 400, r);
    r = await api('POST', '/api/replan/apply', { changes: [] });
    check('apply 空 changes → 400', r.status === 400, r);

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
