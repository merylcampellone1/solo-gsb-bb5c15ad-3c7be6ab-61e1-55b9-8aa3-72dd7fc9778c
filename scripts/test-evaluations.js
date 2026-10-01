'use strict';
// 出货质量处置（整单）：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），逐条验证：
//   评估视图（出货过敏原/逐卷分配/放行快照；当前批次过敏原/有效放行/所用卷停用原因；
//     准予条件判定；签名状态版本）；
//   提交：仅待评估单可处置；CONTINUE 三条硬条件（批次仍存在/有有效放行/快照覆盖当前过敏原），
//         不满足只能 RECALL；操作人与依据必填；版本签名/TTL/最新版本/上下文指纹事务内核对，
//         过期或并发改动拒绝且不产生记录；重复提交（含旧版本）不覆盖新结论；
//   记录只增不改；批次过敏原/有效放行/所用卷停用变化 → 旧结论 STALE（内容保留、不自动生效），
//     STALE 后可重新评估；原出货状态与数量占用始终保持；
//   /api/state、出货单查询含当前结论；整组换线预演预测 dispositions_will_stale、应用实际标记。
//   node scripts/test-evaluations.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39131';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluations-test-'));
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

// 给指定批次的加工事件全量覆盖原料/引用（返回 PUT body）。
function eventPutBody(state, batchCode, { addMaterialIds = [], removeMaterialIds = [] } = {}) {
  const e = state.events.find((x) => x.batch_code === batchCode);
  const remove = new Set(removeMaterialIds);
  const mids = e.inputs.filter((i) => i.material_id).map((i) => i.material_id)
    .filter((id) => !remove.has(id))
    .concat(addMaterialIds);
  return {
    body: {
      type: 'PROCESS', event_time: e.event_time, equipment_id: e.equipment_id,
      note: e.note, batch_code: batchCode,
      material_ids: [...new Set(mids)],
      ref_batch_ids: e.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id)
    },
    id: e.id
  };
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
    const D = '2026-09-30T';

    const state0 = await api('GET', '/api/state');
    const st0 = state0.json;
    const b3 = st0.batches.find((b) => b.code === 'BATCH-003');
    const peanut = st0.materials.find((m) => m.code === 'PEANUT-01').id;
    const set3 = ['蛋', '乳', '芝麻'];

    // ---------- 1. 非待评估单：查询可看但不能处置 ----------
    console.log('1) SHIPPED 单评估视图：reviewable=false，提交处置 409');
    let r = await api('GET', '/api/shipments/SHIP-0001/evaluation');
    check('评估视图 200', r.status === 200, r.status);
    check('reviewable=false / pending=false',
      r.json.review.reviewable === false && r.json.review.pending_review === false, r.json.review);
    check('含出货快照过敏原与逐卷明细',
      JSON.stringify(r.json.shipment_snapshot.allergens) === JSON.stringify(set3) &&
      r.json.shipment_snapshot.items.length === 1 &&
      r.json.shipment_snapshot.items[0].roll_code === 'LABEL-0001' &&
      r.json.shipment_snapshot.items[0].release_by === '质检员-王敏',
      r.json.shipment_snapshot);
    check('含当前批次过敏原/有效放行/卷状态',
      JSON.stringify(r.json.current_state.batch_allergens) === JSON.stringify(set3) &&
      r.json.current_state.active_releases.length === 1 &&
      r.json.current_state.used_rolls[0].status === 'ACTIVE' &&
      r.json.current_state.used_rolls[0].release_active === true,
      r.json.current_state);
    check('三条件均满足 can_continue=true', r.json.conditions.can_continue === true, r.json.conditions);
    check('返回签名状态版本与整数版本号 0',
      typeof r.json.version === 'string' && r.json.version.includes('.') && r.json.status_version === 0,
      { v: r.json.version, sv: r.json.status_version });
    let token0 = r.json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '测试', version: token0
    });
    check('非待评估单提交 → 409 SHIPMENT_NOT_REVIEWABLE',
      r.status === 409 && r.json.code === 'SHIPMENT_NOT_REVIEWABLE', r.json);
    r = await api('GET', '/api/shipments/NO-SUCH/evaluation');
    check('不存在出货单 → 404 SHIPMENT_NOT_FOUND',
      r.status === 404 && r.json.code === 'SHIPMENT_NOT_FOUND', r.json);

    // ---------- 2. 转待评估：状态版本推进 ----------
    console.log('2) 加花生 → SHIP-0001 转 PENDING_REVIEW，状态版本 0→1');
    const addPeanut = eventPutBody(st0, 'BATCH-002', { addMaterialIds: [peanut] });
    r = await api('PUT', `/api/events/${addPeanut.id}`, addPeanut.body);
    check('事件更正 200', r.status === 200, r);
    check('响应附 stale_dispositions 字段（数组）', Array.isArray(r.json.stale_dispositions), r.json);
    r = await api('GET', '/api/shipments/SHIP-0001/evaluation');
    check('待评估 reviewable=true', r.json.review.reviewable === true, r.json.review);
    check('状态版本前进到 1', r.json.status_version === 1, r.json.status_version);
    check('阻断条件：快照不覆盖（花生）+ 无有效放行',
      r.json.conditions.can_continue === false &&
      r.json.conditions.uncovered_allergens.includes('花生') &&
      r.json.conditions.has_active_release === false &&
      r.json.conditions.blockers.length === 2,
      r.json.conditions);
    check('所用卷显示 RETIRED 与停用原因、放行 inactive',
      r.json.current_state.used_rolls[0].status === 'RETIRED' &&
      r.json.current_state.used_rolls[0].retired_reason.includes('花生') &&
      r.json.current_state.used_rolls[0].release_active === false,
      r.json.current_state.used_rolls[0]);
    check('出货快照仍为 蛋/乳/芝麻（不变）',
      JSON.stringify(r.json.shipment_snapshot.allergens) === JSON.stringify(set3));
    check('无历史结论', r.json.history.length === 0 && r.json.current_disposition === null);

    // ---------- 3. CONTINUE 被拒，只能召回 ----------
    console.log('3) 条件不满足时 CONTINUE → 409 CONTINUE_NOT_ALLOWED 且无记录');
    const token1 = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '误判继续流转', version: token1
    });
    check('CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED' &&
      r.json.details.length === 2, r.json);
    r = await api('GET', '/api/shipments/SHIP-0001/evaluation');
    check('被拒不产生记录', r.json.history.length === 0, r.json.history);

    // ---------- 4. 请求体校验 ----------
    console.log('4) 请求体校验：缺版本/伪造版本 → 400；版本合法后结论非法/缺操作人/缺依据/时间格式错 → 400');
    for (const bad of [
      { body: { decision: 'RECALL', decided_by: 'x', basis: 'y' }, why: '缺版本' },
      { body: { decision: 'RECALL', decided_by: 'x', basis: 'y', version: 'a.b' }, why: '伪造签名' },
      { body: { decision: 'RECALL', decided_by: 'x', basis: 'y', version: token1 + 'x' }, why: '错误签名' },
      { body: { decision: 'HOLD', decided_by: 'x', basis: 'y', version: token1 }, why: '结论非法' },
      { body: { decision: 'RECALL', decided_by: '', basis: 'y', version: token1 }, why: '缺操作人' },
      { body: { decision: 'RECALL', decided_by: 'x', basis: '  ', version: token1 }, why: '缺依据' },
      { body: { decision: 'RECALL', decided_by: 'x', basis: 'y', version: token1, decided_at: '2026/10/01' }, why: '时间格式错' }
    ]) {
      r = await api('POST', '/api/shipments/SHIP-0001/dispositions', bad.body);
      check(`${bad.why} → 400（INVALID_REQUEST 或 VERSION_INVALID）`,
        r.status === 400 && ['INVALID_REQUEST', 'VERSION_INVALID'].includes(r.json.code),
        { why: bad.why, code: r.json && r.json.code });
    }

    // ---------- 5. RECALL 成功 ----------
    console.log('5) RECALL 提交成功：记录落账、版本推进、出货单本身不变');
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检-陈静',
      basis: '新增花生过敏原未在出货标签声明，且原放行失效，整批召回',
      version: token1, decided_at: D + '16:00'
    });
    check('RECALL 200', r.status === 200, r.json);
    check('记录 decision=RECALL / ACTIVE / 依据与操作人留存 / expected_version=1',
      r.json.disposition.decision === 'RECALL' &&
      r.json.disposition.life_status === 'ACTIVE' &&
      r.json.disposition.expected_version === 1 &&
      r.json.disposition.status_version === 2 &&
      r.json.disposition.decided_by === '质检-陈静' &&
      r.json.disposition.basis.includes('花生'),
      r.json.disposition);
    check('响应内嵌最新评估视图',
      r.json.evaluation && r.json.evaluation.status_version === 2 &&
      r.json.evaluation.current_disposition.id === r.json.disposition.id,
      r.json.evaluation && r.json.evaluation.status_version);
    let sh = (await api('GET', '/api/shipments/SHIP-0001')).json;
    check('出货单仍 PENDING_REVIEW、数量仍占用 100（处置不改原状态/占用）',
      sh.status === 'PENDING_REVIEW' && sh.allocated_qty === 100, sh);
    check('出货单查询附 current_disposition / disposition_count',
      sh.current_disposition.decision === 'RECALL' &&
      sh.current_disposition.active === true && sh.disposition_count === 1,
      sh.current_disposition);
    sh = (await api('GET', '/api/state')).json.shipments.find((x) => x.shipment_code === 'SHIP-0001');
    check('/api/state 列表也附当前结论',
      sh.current_disposition && sh.current_disposition.decision === 'RECALL', sh.current_disposition);

    // ---------- 6. 只增不改：重复提交 / 旧版本不得覆盖 ----------
    console.log('6) 记录只增不改：重复提交（新查询版本、旧查询版本）均被拒');
    const token2 = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json.version;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '另一人', basis: '试图覆盖', version: token2
    });
    check('新版本重复提交 → 409 DISPOSITION_EXISTS',
      r.status === 409 && r.json.code === 'DISPOSITION_EXISTS', r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '另一人', basis: '旧版本覆盖', version: token1
    });
    check('用旧版本 token1 再提交 → 409 VERSION_EXPIRED（先核版本，不覆盖）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    let ev = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    check('仍只有 1 条记录，操作人/依据未被覆盖',
      ev.history.length === 1 && ev.history[0].decided_by === '质检-陈静',
      ev.history.map((d) => ({ by: d.decided_by, basis: d.basis })));

    // ---------- 7. 并发场景：查询后他人先处置，旧版本过期 ----------
    console.log('7) 需 STALE 后再评估：花生回退 → RECALL 记录 STALE（保留、不自动生效）');
    let st = (await api('GET', '/api/state')).json;
    const removePeanut = eventPutBody(st, 'BATCH-002', { removeMaterialIds: [peanut] });
    r = await api('PUT', `/api/events/${removePeanut.id}`, removePeanut.body);
    check('回退更正 200 且响应 stale_dispositions 点名记录 #1',
      r.status === 200 &&
      r.json.stale_dispositions.some((d) => d.disposition_id === 1 && d.decision === 'RECALL') &&
      r.json.stale_dispositions[0].reason.includes('花生'),
      r.json.stale_dispositions);
    check('出货单不因回退自动恢复（仍 PENDING_REVIEW）',
      (await api('GET', '/api/shipments/SHIP-0001')).json.status === 'PENDING_REVIEW');
    ev = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    check('旧结论 STALE：needs_review=true / current_effective=false / 内容保留',
      ev.current_disposition.life_status === 'STALE' &&
      ev.current_disposition.needs_review === true &&
      ev.current_effective === false &&
      ev.current_disposition.decision === 'RECALL' &&
      ev.current_disposition.stale_reason.includes('花生'),
      ev.current_disposition);

    // 用回退前查询的版本提交重新评估 → 上下文已变，拒绝且不产生记录
    const tokenBeforeRevert = token2;
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '用过期上下文重评',
      version: tokenBeforeRevert
    });
    check('上下文变化后旧版本提交 → 409 VERSION_EXPIRED 且无新记录',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      r.json.error.includes('状态版本已过期'),
      r.json);
    check('记录数仍为 1',
      (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json.history.length === 1);

    // ---------- 8. 有效放行变化也标 STALE：登记新放行后三条件齐全，可 CONTINUE ----------
    console.log('8) 登记新放行（有效放行变化对无结论场景不影响）→ CONTINUE 允许并落第二条记录');
    r = await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: D + '17:00', released_by: '质检员-王敏(复核)'
    });
    check('新放行登记 200', r.status === 200, r.json);
    ev = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    check('当前有有效放行、快照覆盖、批次可推导 → can_continue=true',
      ev.conditions.can_continue === true &&
      ev.conditions.snapshot_covers_current === true &&
      ev.conditions.uncovered_allergens.length === 0 &&
      ev.current_state.active_releases.length === 1,
      ev.conditions);
    check('所用卷仍 RETIRED（停用原因可查），但不阻断按当前有效放行的 CONTINUE',
      ev.current_state.used_rolls[0].status === 'RETIRED' &&
      ev.current_state.used_rolls[0].retired_reason.length > 0);
    const token3 = ev.version;
    const expectedVer3 = ev.status_version;
    check('STALE 后允许重新评估（latest 非 ACTIVE 不再报 DISPOSITION_EXISTS）', true);
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '核实花生为误投料，批次实际过敏原为蛋/乳/芝麻，新有效放行快照一致，出货声明覆盖，准予继续流转',
      version: token3
    });
    check('CONTINUE 200，第二条记录 ACTIVE，第一条仍 STALE 保留',
      r.status === 200 &&
      r.json.disposition.decision === 'CONTINUE' &&
      r.json.disposition.expected_version === expectedVer3 &&
      r.json.disposition.status_version === expectedVer3 + 1 &&
      r.json.evaluation.history.length === 2 &&
      r.json.evaluation.history[0].life_status === 'STALE' &&
      r.json.evaluation.history[1].life_status === 'ACTIVE',
      r.json);

    // ---------- 9. 删除有效放行：CONTINUE 结论立即 STALE（有效放行 + 卷停用信息变化）----------
    console.log('9) 删除新放行 → CONTINUE 结论 STALE；旧两条记录都保留');
    r = await api('DELETE', `/api/releases/${r.json.evaluation.current_state.active_releases[0].id}`);
    check('删除放行响应附 stale_dispositions（CONTINUE 记录）',
      r.status === 200 &&
      r.json.stale_dispositions.some((d) => d.decision === 'CONTINUE') &&
      r.json.stale_dispositions[0].reason.includes('有效放行'),
      r.json.stale_dispositions);
    ev = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    check('当前结论 STALE、原因含“有效放行”',
      ev.current_disposition.life_status === 'STALE' &&
      ev.current_disposition.stale_reason.includes('有效放行'),
      ev.current_disposition);
    check('两条历史结论内容均原样保留（只增不改）',
      ev.history.length === 2 &&
      ev.history[0].decision === 'RECALL' && ev.history[0].decided_by === '质检-陈静' &&
      ev.history[1].decision === 'CONTINUE' && ev.history[1].basis.includes('准予继续流转'),
      ev.history.map((d) => ({ decision: d.decision, life: d.life_status })));
    check('can_continue 回到 false（无有效放行），只能召回',
      ev.conditions.can_continue === false && ev.conditions.only_recall === true);

    // ---------- 10. 另一张出货单：多卷、覆盖判断（快照是当前超集）----------
    console.log('10) 第二张单：准备放行/新卷/出货 → 转待评估（仅放行变化）→ RECALL 再评估');
    // 重新登记放行 + 新卷 + 贴用 + 出货（此时当前=快照=蛋/乳/芝麻）
    r = await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: D + '17:30', released_by: '复核员-高燕'
    });
    const relB = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b3.id, release_id: relB, allergens: set3, print_qty: 100, registered_by: '组长'
    });
    const rollB = r.json.id;
    r = await api('POST', `/api/label-rolls/${rollB}/consume`,
      { expected_revision: 0, applied: 30, voided: 0, used_by: '赵强' });
    check('新卷贴用 30', r.status === 200, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: b3.id, ship_qty: 30, shipped_by: '仓管-孙倩',
      allocations: [{ roll_id: rollB, qty: 30 }]
    });
    const shipBCode = r.json.shipment_code;
    check('第二张出货成功 SHIPPED', r.status === 200 && shipBCode, r.json);
    // 删除该放行：卷停用 → 单据转待评估（批次过敏原本身没变，只是放行没了）
    r = await api('DELETE', `/api/releases/${relB}`);
    check('删放行：新单转待评估',
      r.json.pending_shipments.some((s) => s.shipment_code === shipBCode),
      r.json.pending_shipments);
    ev = (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json;
    check('阻断仅“无有效放行”（快照仍覆盖当前过敏原）',
      ev.conditions.can_continue === false &&
      ev.conditions.snapshot_covers_current === true &&
      ev.conditions.blockers.length === 1 &&
      ev.conditions.blockers[0].includes('有效放行'),
      ev.conditions);
    const tokenB = ev.version;
    r = await api('POST', `/api/shipments/${shipBCode}/dispositions`, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '绑定放行被删，标签卷停用，召回', version: tokenB
    });
    check('第二张单 RECALL 成功',
      r.status === 200 && r.json.disposition.decision === 'RECALL', r.json);
    // 登记一个不同批次的放行不应影响本单上下文以外内容；本单仍因无放行不能 CONTINUE
    // 再登记该批放行（卷仍停用）：上下文变化 → RECALL 应 STALE
    r = await api('POST', '/api/releases', {
      batch_id: b3.id, released_at: D + '18:00', released_by: '复核员-高燕2'
    });
    check('再次登记放行使旧 RECALL 标 STALE（有效放行变化）',
      (r.json.stale_dispositions || []).some((d) => d.shipment_code === shipBCode &&
        d.reason.includes('有效放行')),
      r.json.stale_dispositions);
    ev = (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json;
    // 卷仍停用，但批次存在/有放行/快照覆盖 → 按规则可 CONTINUE（停卷原因仅展示）
    check('有新放行后 can_continue=true（停用卷原因展示，不构成阻断）',
      ev.conditions.can_continue === true &&
      ev.current_state.used_rolls[0].status === 'RETIRED',
      ev.conditions);

    // ---------- 11. 并发：查询后先发生一次正式写入（状态版本推进）→ 旧版本拒绝 ----------
    console.log('11) 乐观版本：查询后单据状态版本被推进，旧版本提交拒绝且不产生记录');
    const tokenStale1 = ev.version;
    // 让该单状态版本再前进一步：只能通过“再登记一条处置”（STALE 后允许）
    r = await api('POST', `/api/shipments/${shipBCode}/dispositions`, {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '先行登记的并发结论', version: tokenStale1
    });
    check('并发前先登记者成功', r.status === 200, r.json);
    const histBefore = (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json.history.length;
    r = await api('POST', `/api/shipments/${shipBCode}/dispositions`, {
      decision: 'RECALL', decided_by: '迟到的操作人', basis: '用查询时旧版本覆盖', version: tokenStale1
    });
    check('旧版本（整数状态版本已前进）→ 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      r.json.error.includes('最新版本'), r.json);
    const histAfter = (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json.history.length;
    check('过期被拒不产生记录', histBefore === histAfter, { histBefore, histAfter });

    // ---------- 12. 整组换线：预演预测 dispositions_will_stale，应用实际标记 ----------
    console.log('12) 整组换线：预演 diff 含 dispositions_will_stale，应用后正式标记；旧预演版本过期');
    // 当前 SHIP-0001 的最新结论是 STALE；让一张单带 ACTIVE 结论并依赖 BATCH-003 过敏原。
    // SHIP-0001 目前无 ACTIVE 结论（两条都 STALE），shipBCode 最新为 ACTIVE CONTINUE。
    st = (await api('GET', '/api/state')).json;
    const e1 = st.events.find((x) => x.batch_code === 'BATCH-001');
    const clean0900 = st.events.find((x) => x.type === 'CLEAN' && x.event_time === D + '09:00');
    const swapChanges = [
      {
        op: 'update', event_id: e1.id, type: 'PROCESS',
        event_time: D + '09:00', equipment_id: e1.equipment_id, note: e1.note,
        batch_code: 'BATCH-001',
        material_ids: e1.inputs.filter((i) => i.material_id).map((i) => i.material_id),
        ref_batch_ids: []
      },
      {
        op: 'update', event_id: clean0900.id, type: 'CLEAN',
        event_time: D + '08:00', equipment_id: clean0900.equipment_id,
        note: '换线前已核实清洗'
      }
    ];
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    check('预演 200', r.status === 200, r.status);
    const previewVersion = r.json.version;
    check('预演 diff 含 dispositions_will_stale 汇总与明细',
      r.json.diff.summary.dispositions_will_stale >= 1 &&
      r.json.diff.dispositions_will_stale.some((d) => d.shipment_code === shipBCode) &&
      r.json.diff.dispositions_will_stale.some((d) => d.reason.includes('花生') ||
        d.reason.includes('过敏原')),
      r.json.diff.dispositions_will_stale);
    // 预演不改正式数据
    check('预演后正式 ACTIVE 结论仍在',
      (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json.current_disposition.active === true);

    // 预演后登记一次处置（正式指纹变化）→ 旧预演版本应过期。
    // shipBCode 已有 ACTIVE 结论无法再登记；改为对 SHIP-0001（latest STALE，可再评）登记。
    ev = (await api('GET', '/api/shipments/SHIP-0001/evaluation')).json;
    const r2 = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '预演后插入的正式处置', version: ev.version
    });
    check('预演后正式写入处置成功（指纹前进）', r2.status === 200, r2.json);
    r = await api('POST', '/api/replan/apply', { version: previewVersion, changes: swapChanges });
    check('用旧预演版本应用 → 409 VERSION_EXPIRED，原状态不变',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    check('被拒后 ACTIVE 结论仍在',
      (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json.current_disposition.active === true);

    // 重新预演并应用
    r = await api('POST', '/api/replan/preview', { changes: swapChanges });
    r = await api('POST', '/api/replan/apply', { version: r.json.version, changes: swapChanges });
    check('应用 200 且响应 stale_dispositions 非空',
      r.status === 200 && Array.isArray(r.json.stale_dispositions) &&
      r.json.stale_dispositions.length >= 1, r.json.stale_dispositions);
    check('diff.summary.dispositions_will_stale 与明细一致',
      r.json.diff.summary.dispositions_will_stale === r.json.diff.dispositions_will_stale.length);
    ev = (await api('GET', `/api/shipments/${shipBCode}/evaluation`)).json;
    check('正式库 ACTIVE CONTINUE 已标 STALE，原因可查（过敏原/放行）',
      ev.current_disposition.life_status === 'STALE' &&
      ev.current_disposition.stale_reason.length > 0,
      ev.current_disposition);

    // ---------- 13. 批次删除场景：出货单保留，batch_exists=false，只能召回 ----------
    console.log('13) 独立批次出货后批次连带删除：单据保留，评估显示批次不存在，CONTINUE 被拒');
    const salt = st0.materials.find((m) => m.code === 'SALT-01').id;
    const lineA = st0.equipment.find((q) => q.code === 'LINE-A').id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: D + '18:00', equipment_id: lineA,
      note: '无过敏原验证批', batch_code: 'BATCH-006',
      material_ids: [salt], ref_batch_ids: []
    });
    check('新增 BATCH-006 加工事件 200', r.status === 200, r.json);
    st = (await api('GET', '/api/state')).json;
    const b6 = st.batches.find((b) => b.code === 'BATCH-006');
    r = await api('POST', '/api/releases', {
      batch_id: b6.id, released_at: D + '18:10', released_by: '质检员-王敏'
    });
    const rel6 = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: b6.id, release_id: rel6, allergens: [], print_qty: 50, registered_by: '组长'
    });
    const roll6 = r.json.id;
    await api('POST', `/api/label-rolls/${roll6}/consume`,
      { expected_revision: 0, applied: 10, voided: 0 });
    r = await api('POST', '/api/shipments', {
      batch_id: b6.id, ship_qty: 10, shipped_by: '仓管-孙倩',
      allocations: [{ roll_id: roll6, qty: 10 }]
    });
    const ship6 = r.json.shipment_code;
    check('BATCH-006 出货 10 张 SHIPPED', r.status === 200 && ship6 === 'SHIP-0003', r.json);
    // 放行删除 → 卷停用 → 单转待评估；登记一条 ACTIVE RECALL
    await api('DELETE', `/api/releases/${rel6}`);
    ev = (await api('GET', `/api/shipments/${ship6}/evaluation`)).json;
    check('BATCH-006 单待评估', ev.review.pending_review === true);
    const token6 = ev.version;
    r = await api('POST', `/api/shipments/${ship6}/dispositions`, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '放行删除先行召回', version: token6
    });
    check('BATCH-006 单 RECALL 落账', r.status === 200, r.json);
    // 放行已删、卷仍在（不阻止事件删除的放行检查）；该批无被引用 → 删除加工事件致批次连带删除
    st = (await api('GET', '/api/state')).json;
    const ev6Id = st.events.find((x) => x.batch_code === 'BATCH-006').id;
    r = await api('DELETE', `/api/events/${ev6Id}`);
    check('删除 BATCH-006 加工事件（批次连带删除）200', r.status === 200, r.json);
    ev = (await api('GET', `/api/shipments/${ship6}/evaluation`)).json;
    check('单据保留：batch_id 置空、batch_exists=false、批次编码快照仍在',
      ev.shipment.batch_id === null &&
      ev.current_state.batch_exists === false &&
      ev.shipment.batch_code === 'BATCH-006',
      { bid: ev.shipment.batch_id, exists: ev.current_state.batch_exists });
    check('阻断原因含“批次已不存在”，can_continue=false',
      ev.conditions.can_continue === false &&
      ev.conditions.blockers.some((x) => x.includes('批次已不存在')),
      ev.conditions);
    check('原 ACTIVE RECALL 已因批次不存在标 STALE',
      ev.current_disposition.life_status === 'STALE' &&
      ev.current_disposition.stale_reason.includes('批次已不存在'),
      ev.current_disposition);
    r = await api('POST', `/api/shipments/${ship6}/dispositions`, {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '批次都没了还想继续？', version: ev.version
    });
    check('批次不存在时 CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED' &&
      r.json.details.some((x) => x.includes('批次已不存在')), r.json);
    r = await api('POST', `/api/shipments/${ship6}/dispositions`, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '批次档案删除，维持召回', version: ev.version
    });
    check('批次不存在时 RECALL 仍允许（只增第二条）',
      r.status === 200 && r.json.disposition.decision === 'RECALL' &&
      r.json.evaluation.history.length === 2, r.json);
    check('出货明细快照（卷号/过敏原/分配数）仍完整可查',
      ev.shipment_snapshot.items.length === 1 &&
      ev.shipment_snapshot.items[0].roll_code === `LABEL-${String(roll6).padStart(4, '0')}` &&
      ev.shipment_snapshot.items[0].qty === 10,
      ev.shipment_snapshot.items);
    check('已删批次余额查询 → 400 BATCH_NOT_FOUND',
      (await api('GET', `/api/batches/${b6.id}/shipment-balance`)).status === 400);

    // ---------- 14. 停卷规则/数量占用始终保持 ----------
    console.log('14) 处置全程不改变出货状态、数量占用与停卷规则');
    const balances = (await api('GET', `/api/batches/${b3.id}/shipment-balance`)).json;
    check('已停卷余额恒 0、已分配数量不退回',
      balances.rolls.every((x) => x.status === 'RETIRED' ? x.available_qty === 0 : true) &&
      balances.rolls.reduce((s, x) => s + x.allocated_qty, 0) >= 130,
      balances.rolls.map((x) => ({ c: x.roll_code, st: x.status, alloc: x.allocated_qty, av: x.available_qty })));
    r = await api('GET', '/api/shipments?status=PENDING_REVIEW');
    check('三张出货单仍 PENDING_REVIEW（处置不自动改状态）',
      r.json.length === 3 && r.json.every((s) => s.status === 'PENDING_REVIEW'),
      r.json.map((s) => s.shipment_code));
    check('列表每条均带当前结论与历史计数（含批次已删除的 SHIP-0003）',
      r.json.length === 3 &&
      r.json.every((s) => s.current_disposition && s.disposition_count >= 1) &&
      r.json.some((s) => s.shipment_code === ship6 && s.batch_code === 'BATCH-006' && s.batch_id === null),
      r.json.map((s) => ({
        c: s.shipment_code, bid: s.batch_id, n: s.disposition_count,
        life: s.current_disposition.life_status
      })));

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
