'use strict';
// 过敏原标签卷：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   登记三方一致 / 不一致拒绝 / 正整数印量 / 卷号与可用张数；
//   核销修订号（旧号拒绝）、负数拒绝、累计超印量拒绝、整次回滚；
//   集合改变、放行失效/删除 → 永久停用、余量冻结、已贴待复核、恢复不解冻；
//   整组预演预测停用、确认应用实际停用、影子库隔离。
//   node scripts/test-labels.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39128';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-test-'));
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
    const byCode = (code) => state0.events.find((e) => e.batch_code === code);
    const b3 = state0.batches.find((b) => b.code === 'BATCH-003');
    const rel3 = b3.releases.find((r) => r.status === 'ACTIVE');
    const e1 = byCode('BATCH-001');
    const e3 = byCode('BATCH-002');
    const peanut = state0.materials.find((m) => m.code === 'PEANUT-01').id;
    const set3 = ['蛋', '乳', '芝麻']; // BATCH-003 当前推导 = 放行快照

    // ---------- 1. 演示数据自带一卷 ----------
    console.log('1) 演示数据自带标签卷且计数正确');
    check('初始 1 卷', state0.label_rolls.length === 1, state0.label_rolls);
    const demo = state0.label_rolls[0];
    check('卷号 LABEL-0001', demo.roll_code === 'LABEL-0001', demo);
    check('印量 500 / 贴 120 / 作废 5 / 剩 375',
      demo.print_qty === 500 && demo.applied_qty === 120 &&
      demo.void_qty === 5 && demo.remaining_qty === 375, demo);
    check('修订号 2', demo.revision === 2, demo);
    check('演示卷 ACTIVE', demo.active === true, demo);

    // ---------- 2. 三方一致登记 ----------
    console.log('2) 拟印集合与当前推导、放行快照一致，登记成功并返回卷号/可用张数');
    let r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3.id, allergens: set3,
      print_qty: 100, registered_by: '测试员甲'
    });
    check('返回 200', r.status === 200, r);
    check('卷号 LABEL-0002', r.json.roll_code === 'LABEL-0002', r.json);
    check('可用张数 100', r.json.remaining_qty === 100 && r.json.revision === 0, r.json);
    const roll2Id = r.json.id;

    // 顺序无关/重复元素也视为同一集合
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3.id, allergens: ['芝麻', '乳', '蛋', '蛋'],
      print_qty: 10
    });
    check('乱序+重复集合仍一致，可登记', r.status === 200 && r.json.roll_code === 'LABEL-0003', r.json);

    // ---------- 3. 登记拒绝场景 ----------
    console.log('3) 登记拒绝：集合不一致 / 非正整数 / 他批放行 / 失效放行');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: rel3.id, allergens: ['乳'], print_qty: 100
    });
    check('集合不一致 → 400 ALLERGENS_MISMATCH',
      r.status === 400 && r.json.code === 'ALLERGENS_MISMATCH' &&
      r.json.details.length === 3, r.json);
    for (const bad of [0, -5, 1.5, 'abc', null]) {
      r = await api('POST', '/api/label-rolls', {
        batch_id: b3.id, release_id: rel3.id, allergens: set3, print_qty: bad
      });
      check(`印量 ${JSON.stringify(bad)} 拒绝`, r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    }
    const b1 = state0.batches.find((b) => b.code === 'BATCH-001');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b1.id, release_id: rel3.id,
      allergens: b1.allergens, print_qty: 10
    });
    check('放行不属于该批次 → 400 RELEASE_BATCH_MISMATCH',
      r.status === 400 && r.json.code === 'RELEASE_BATCH_MISMATCH', r.json);
    r = await api('POST', '/api/label-rolls', {
      batch_id: 999999, release_id: rel3.id, allergens: set3, print_qty: 10
    });
    check('批次不存在 → 400', r.status === 400, r.json);

    // ---------- 4. 核销：正常 + 修订号 ----------
    console.log('4) 核销：成功后修订号 +1；旧修订号整次拒绝');
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 0, applied: 30, voided: 2, used_by: '包装工' });
    check('rev0 核销 30/2 成功，剩 68，rev→1',
      r.status === 200 && r.json.applied_qty === 30 && r.json.void_qty === 2 &&
      r.json.remaining_qty === 68 && r.json.revision === 1, r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 0, applied: 5, voided: 0 });
    check('旧修订号 0 → 409 REVISION_MISMATCH',
      r.status === 409 && r.json.code === 'REVISION_MISMATCH', r.json);
    let st = (await api('GET', '/api/state')).json.label_rolls.find((x) => x.id === roll2Id);
    check('旧号拒绝后数量不变（仍 30/2，rev1）',
      st.applied_qty === 30 && st.void_qty === 2 && st.revision === 1, st);

    // ---------- 5. 核销：负数 / 超量 / 零单 / 停用卷 ----------
    console.log('5) 核销：负数 400、累计超印量 409、恰好贴满允许');
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 1, applied: -1, voided: 0 });
    check('负数贴用 → 400', r.status === 400 && r.json.code === 'INVALID_REQUEST', r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 1, applied: 0, voided: -2 });
    check('负数作废 → 400', r.status === 400, r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 1, applied: 70, voided: 0 });
    check('超印量（68 余量申请 70）→ 409 OVER_LIMIT',
      r.status === 409 && r.json.code === 'OVER_LIMIT', r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 1, applied: 67, voided: 1 });
    check('恰好贴满（67+1=68）成功，剩 0，rev→2',
      r.status === 200 && r.json.remaining_qty === 0 && r.json.revision === 2, r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 2, applied: 1, voided: 0 });
    check('印量用尽后再贴 → 409 OVER_LIMIT',
      r.status === 409 && r.json.code === 'OVER_LIMIT', r.json);
    r = await api('POST', `/api/label-rolls/${roll2Id}/consume`,
      { expected_revision: 2, applied: 0, voided: 0 });
    check('全零核销 → 400', r.status === 400, r.json);

    // ---------- 6. 集合改变 → 卷永久停用（原料/加工事件） ----------
    console.log('6) 加工事件变更使集合改变：放行失效 + 标签卷永久停用');
    // 给 BATCH-002 加花生，经设备残留/引用传播到 BATCH-003
    const e3full = {
      type: 'PROCESS', event_time: e3.event_time, equipment_id: e3.equipment_id,
      note: e3.note, batch_code: e3.batch_code,
      material_ids: e3.inputs.filter((i) => i.material_id).map((i) => i.material_id).concat(peanut),
      ref_batch_ids: e3.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    };
    r = await api('PUT', `/api/events/${e3.id}`, e3full);
    check('事件更正 200', r.status === 200, r);
    check('响应含 retired_rolls',
      Array.isArray(r.json.retired_rolls) && r.json.retired_rolls.length >= 3,
      r.json.retired_rolls);
    st = (await api('GET', '/api/state')).json;
    const demoAfter = st.label_rolls.find((x) => x.roll_code === 'LABEL-0001');
    check('LABEL-0001 已 RETIRED', demoAfter.status === 'RETIRED', demoAfter);
    check('余量 375 冻结', demoAfter.remaining_qty === 375, demoAfter);
    check('已贴 120 标记待复核', demoAfter.applied_pending_review === 120, demoAfter);
    check('停用原因非空', demoAfter.retired_reason.length > 0, demoAfter.retired_reason);
    r = await api('POST', `/api/label-rolls/${demoAfter.id}/consume`,
      { expected_revision: demoAfter.revision, applied: 1, voided: 0 });
    check('停用卷核销 → 409 ROLL_RETIRED',
      r.status === 409 && r.json.code === 'ROLL_RETIRED', r.json);

    // ---------- 7. 集合恢复不自动解冻 ----------
    console.log('7) 撤销改动使集合恢复，旧卷不自动解冻');
    const e3back = { ...e3full, material_ids: e3.inputs.filter((i) => i.material_id).map((i) => i.material_id) };
    r = await api('PUT', `/api/events/${e3.id}`, e3back);
    check('回退更正 200', r.status === 200, r);
    st = (await api('GET', '/api/state')).json;
    check('LABEL-0001 仍 RETIRED（终态）',
      st.label_rolls.find((x) => x.roll_code === 'LABEL-0001').status === 'RETIRED', st.label_rolls);

    // ---------- 8. 恢复后用新放行登记新卷，再删放行 → 停用 ----------
    console.log('8) 删除绑定放行 → 名下卷永久停用；新卷可登记但不影响旧卷');
    r = await api('POST', '/api/releases',
      { batch_id: b3.id, released_at: D + '16:00', released_by: '复核员' });
    check('集合恢复后登记新放行 200', r.status === 200, r);
    st = (await api('GET', '/api/state')).json;
    const newRel = st.batches.find((b) => b.id === b3.id).releases.find((x) => x.status === 'ACTIVE');
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: newRel.id, allergens: set3, print_qty: 50
    });
    check('新卷 LABEL-0004 可登记', r.status === 200 && r.json.roll_code === 'LABEL-0004', r.json);
    const roll4Id = r.json.id;
    r = await api('DELETE', `/api/releases/${newRel.id}`);
    check('删除放行 200', r.status === 200, r);
    check('删除响应含 retired_rolls（新卷）',
      r.json.retired_rolls.some((x) => x.id === roll4Id), r.json);
    st = (await api('GET', '/api/state')).json;
    const roll4 = st.label_rolls.find((x) => x.id === roll4Id);
    check('新卷已停用且原因含“已删除”',
      roll4.status === 'RETIRED' && roll4.retired_reason.includes('已删除'), roll4);
    check('页面数据含批次/印量/贴用/作废/剩余/停用原因字段',
      ['roll_code', 'print_qty', 'applied_qty', 'void_qty', 'remaining_qty',
        'status', 'retired_reason', 'batch_code'].every((k) => k in roll4), roll4);

    // ---------- 9. 整组预演：预测停用且隔离正式库 ----------
    console.log('9) 换线整组预演预测标签卷停用，且不改动正式库');
    // 重新准备一卷 ACTIVE
    r = await api('POST', '/api/releases',
      { batch_id: b3.id, released_at: D + '16:30', released_by: '复核员2' });
    const relForPreview = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: relForPreview, allergens: set3, print_qty: 80
    });
    const previewRollId = r.json.id;
    check('准备预演用新卷成功', r.status === 200, r.json);

    const swapChanges = [
      {
        op: 'update', event_id: e1.id, type: 'PROCESS',
        event_time: D + '09:00', equipment_id: e1.equipment_id, note: e1.note,
        batch_code: 'BATCH-001',
        material_ids: e1.inputs.filter((i) => i.material_id).map((i) => i.material_id),
        ref_batch_ids: []
      },
      {
        op: 'update', event_id: st.events.find((x) => x.type === 'CLEAN' && x.event_time === D + '09:00').id,
        type: 'CLEAN', event_time: D + '08:00', equipment_id: e1.equipment_id, note: '换线前已核实清洗'
      }
    ];
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('预演 200', r.status === 200, r);
    check('预演差异含 label_rolls_will_retire 计数',
      r.json.diff.summary.label_rolls_will_retire >= 1, r.json.diff);
    check('预演将停用列表包含新卷',
      r.json.diff.label_rolls_will_retire.some((x) => x.roll_id === previewRollId),
      r.json.diff.label_rolls_will_retire);
    st = (await api('GET', '/api/state')).json;
    check('预演后正式卷仍 ACTIVE（隔离）',
      st.label_rolls.find((x) => x.id === previewRollId).status === 'ACTIVE', st.label_rolls);

    // ---------- 10. 确认应用：事务落库并实际停用 ----------
    console.log('10) 确认应用后正式库卷被永久停用');
    r = await api('POST', '/api/replan/apply', { version: r.json.version, changes: swapChanges });
    check('应用 200', r.status === 200, r);
    check('应用响应 retired_rolls 含新卷',
      r.json.retired_rolls.some((x) => x.id === previewRollId), r.json.retired_rolls);
    st = (await api('GET', '/api/state')).json;
    check('正式库新卷 RETIRED',
      st.label_rolls.find((x) => x.id === previewRollId).status === 'RETIRED', st.label_rolls);

    // ---------- 11. 既有接口字段语义不变 ----------
    console.log('11) 既有接口字段保持（/api/state 顶层字段仍齐全，事件/放行接口形状不变）');
    st = (await api('GET', '/api/state')).json;
    for (const k of ['materials', 'equipment', 'events', 'batches']) {
      check(`/api/state 仍含 ${k}`, Array.isArray(st[k]), typeof st[k]);
    }
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: D + '10:00', equipment_id: 1, note: '冲突测试'
    });
    check('单条事件接口语义不变（同设备同时刻仍 400）', r.status === 400, r);

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
