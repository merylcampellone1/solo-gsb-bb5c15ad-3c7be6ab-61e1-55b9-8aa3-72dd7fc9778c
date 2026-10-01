'use strict';

let state = { materials: [], equipment: [], events: [], batches: [], label_rolls: [], shipments: [] };
let editingEventId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtTime(t) {
  return t ? t.replace('T', ' ') : '—';
}
function allergenTags(list, emptyText = '无过敏原') {
  if (!list || !list.length) return `<span class="tag none">${esc(emptyText)}</span>`;
  return list.map((a) => `<span class="tag">${esc(a)}</span>`).join('');
}
function pathClass(p) {
  if (p.includes('设备残留')) return 'path-res';
  if (p.includes('批次引用')) return 'path-ref';
  return 'path-raw';
}

function notice(type, title, items) {
  const box = $('#notice');
  box.className = `notice ${type}`;
  const list = Array.isArray(items) && items.length
    ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    : (items ? `<div>${esc(items)}</div>` : '');
  box.innerHTML = `<span class="close">×</span><b>${esc(title)}</b>${list}`;
  box.querySelector('.close').onclick = () => box.classList.add('hidden');
  clearTimeout(notice._t);
  if (type === 'ok') notice._t = setTimeout(() => box.classList.add('hidden'), 5000);
}

function reportInvalidated(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `重算后 ${list.length} 条放行记录已失效`,
      list.map((r) => `${r.batch_code}：${r.reason}`));
  }
}

function reportRetiredRolls(list) {
  if (Array.isArray(list) && list.length) {
    notice('error', `${list.length} 卷过敏原标签已永久停用（余量冻结，已贴数量待复核）`,
      list.map((r) => `${r.roll_code || ('卷#' + r.id)}${r.batch_code ? '（' + r.batch_code + '）' : ''}：${r.reason}`));
  }
}

function reportPendingShipments(list) {
  if (Array.isArray(list) && list.length) {
    notice('warn', `${list.length} 张出货单需质量评估（待评估，不自动恢复）`,
      list.map((s) => `${s.shipment_code || ('出货单#' + s.id)}：${s.review_reason}`));
  }
}

// ================= 渲染 =================
async function refresh() {
  state = await api('/api/state');
  renderResidue();
  renderBatches();
  renderRolls();
  renderBalances();
  renderShipments();
  renderEvents();
  renderBase();
}

function renderResidue() {
  $('#residueCards').innerHTML = state.equipment.map((q) => `
    <div class="residue-card">
      <h4>${esc(q.name)} <span class="batch-meta">(${esc(q.code)})</span></h4>
      <div class="residue-meta">最后已核实清洗：${q.last_cleaned_at ? esc(fmtTime(q.last_cleaned_at)) : '无记录'}</div>
      ${q.allergens.length
        ? `<div class="tag-row">${allergenTags(q.allergens, '')}</div>
           <details><summary>查看残留来源路径（${Object.values(q.paths).reduce((n, p) => n + p.length, 0)} 条）</summary>
             ${renderPaths(q.paths)}</details>`
        : '<div class="residue-empty">✓ 当前无残留（已清洗或尚未加工）</div>'}
    </div>`).join('');
}

function renderPaths(paths) {
  const keys = Object.keys(paths);
  if (!keys.length) return '';
  return `<div class="paths">${keys.map((a) => `
    <div class="path-block">
      <span class="allergen-name">${esc(a)}</span>
      <ul class="path-list">
        ${paths[a].map((p) => `<li class="${pathClass(p)}">${esc(p)}</li>`).join('')}
      </ul>
    </div>`).join('')}</div>`;
}

function renderBatches() {
  $('#batchList').innerHTML = state.batches.map((b) => {
    const validRelease = (b.releases || []).find((r) => r.status === 'ACTIVE');
    const invalidReleases = (b.releases || []).filter((r) => r.status === 'INVALIDATED');
    return `
    <div class="batch-card">
      <div class="batch-head">
        <span class="batch-code">${esc(b.code)}</span>
        <span class="batch-meta">产出 ${b.produced_at ? esc(fmtTime(b.produced_at)) : '—'} · 设备 ${esc(b.equipment_code || '—')}</span>
        <span class="spacer"></span>
        ${validRelease
          ? '<span class="badge active">放行有效</span>'
          : (invalidReleases.length ? '<span class="badge invalid">放行已失效</span>' : '<span class="tag none">未放行</span>')}
        <button class="btn small primary" onclick="openRelease(${b.id})">登记放行</button>
      </div>
      ${renderBatchRollSummary(b.id)}
      <div style="margin-top:8px" class="tag-row">
        <b style="font-size:12.5px;color:var(--muted)">推导过敏原：</b>${allergenTags(b.allergens)}
      </div>
      ${renderPaths(b.paths)}
      <div class="release-box">
        ${(b.releases || []).map((r) => `
          <div class="release-item ${r.status === 'INVALIDATED' ? 'invalid' : ''}">
            <div class="rl-head">
              <span class="badge ${r.status === 'ACTIVE' ? 'active' : 'invalid'}">
                ${r.status === 'ACTIVE' ? '放行有效' : '已失效'}
              </span>
              <span class="muted">${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}</span>
              <span class="spacer"></span>
              <span class="muted">登记时集合：${r.snapshot_allergens.length ? esc(r.snapshot_allergens.join('、')) : '无'}</span>
              <button class="btn small danger" onclick="deleteRelease(${r.id})">删除</button>
            </div>
            ${r.status === 'INVALIDATED' ? `<div class="invalid-reason">⚠ 失效原因：${esc(r.invalid_reason)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
  }).join('') || '<div class="batch-meta">尚无批次，请先录入加工事件。</div>';
}

function renderBatchRollSummary(batchId) {
  const rolls = (state.label_rolls || []).filter((r) => r.batch_id === batchId);
  if (!rolls.length) return '';
  const active = rolls.filter((r) => r.active).length;
  const retired = rolls.length - active;
  return `
    <div class="batch-roll-summary" onclick="gotoRolls()">
      📦 标签卷 ${rolls.length} 卷：
      <b>${active}</b> 卷可用${retired ? `，<span class="retired-text">${retired} 卷已停用</span>` : ''}
      <span class="batch-meta">（点击查看印量/贴用/作废/剩余）</span>
    </div>`;
}
window.gotoRolls = function () {
  $$('.tab').find((x) => x.dataset.tab === 'labels').click();
};

function renderRolls() {
  const rolls = state.label_rolls || [];
  if (!rolls.length) {
    $('#rollList').innerHTML = '<div class="batch-meta">尚无标签卷。包装前请先选择“存在有效放行”的批次登记一卷。</div>';
    return;
  }
  // 按批次分组（含批次已删除的孤儿卷）
  const groups = new Map();
  for (const r of rolls) {
    const key = r.batch_id == null ? '__orphan__' : r.batch_id;
    if (!groups.has(key)) groups.set(key, { code: r.batch_code || '（批次已删除）', items: [] });
    groups.get(key).items.push(r);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) =>
    (a[0] === '__orphan__' ? 1 : 0) - (b[0] === '__orphan__' ? 1 : 0) ||
    a[1].code.localeCompare(b[1].code, 'zh'));

  $('#rollList').innerHTML = sortedGroups.map(([, g]) => `
    <div class="roll-group">
      <h3 class="roll-group-title">批次 ${esc(g.code)}</h3>
      ${g.items.map(renderRollCard).join('')}
    </div>`).join('');
}

function renderRollCard(r) {
  return `
  <div class="roll-card ${r.active ? '' : 'retired'}">
    <div class="roll-head">
      <span class="roll-code">${esc(r.roll_code)}</span>
      <span class="badge ${r.active ? 'active' : 'invalid'}">${r.active ? '使用中' : '已永久停用'}</span>
      <span class="batch-meta">登记 ${esc(fmtTime(r.registered_at))} · ${esc(r.registered_by)}</span>
      <span class="spacer"></span>
      <span class="batch-meta">当前修订号 <b>${r.revision}</b></span>
    </div>
    <div class="tag-row" style="margin:8px 0">
      <b class="batch-meta">拟印集合：</b>${allergenTags(r.allergens, '无过敏原')}
      ${r.release_id ? '' : '<span class="tag danger">绑定放行已删除</span>'}
    </div>
    <div class="roll-numbers">
      <div class="roll-num"><span class="n">${r.print_qty}</span><span class="l">印量</span></div>
      <div class="roll-num"><span class="n">${r.applied_qty}</span><span class="l">贴用${r.active ? '' : '（待复核）'}</span></div>
      <div class="roll-num"><span class="n">${r.void_qty}</span><span class="l">作废</span></div>
      <div class="roll-num ${r.active ? 'remain' : 'remain-frozen'}">
        <span class="n">${r.remaining_qty}</span><span class="l">${r.active ? '剩余可贴' : '余量冻结'}</span>
      </div>
    </div>
    ${r.active ? `
      <form class="consume-form" data-roll-id="${r.id}">
        <input type="hidden" name="expected_revision" value="${r.revision}">
        <span class="batch-meta">按修订号 ${r.revision} 核销：</span>
        <label>贴用 <input type="number" name="applied" min="0" step="1" value="0"></label>
        <label>作废 <input type="number" name="voided" min="0" step="1" value="0"></label>
        <label>操作人 <input type="text" name="used_by" placeholder="姓名/工号" class="consume-by"></label>
        <button type="submit" class="btn small primary">核销（整次提交）</button>
      </form>` : `
      <div class="roll-retired-reason">⛔ 停用原因：${esc(r.retired_reason || '—')}</div>
      <div class="batch-meta">已贴 ${r.applied_qty} 张已标记待复核；即使集合后来恢复，本卷也不会自动解冻。</div>`}
  </div>`;
}

// ================= 包装出货：余额与出货单 =================
function renderBalances() {
  const byBatch = new Map();
  for (const b of state.batches) byBatch.set(b.id, []);
  for (const r of state.label_rolls || []) {
    if (r.batch_id != null && byBatch.has(r.batch_id)) byBatch.get(r.batch_id).push(r);
  }

  const cards = state.batches.map((b) => {
    const rolls = byBatch.get(b.id) || [];
    const shippable = rolls
      .filter((r) => r.active)
      .reduce((s, r) => s + Math.max(r.applied_qty - (r.allocated_qty || 0), 0), 0);
    const applied = rolls.reduce((s, r) => s + r.applied_qty, 0);
    const allocated = rolls.reduce((s, r) => s + (r.allocated_qty || 0), 0);
    const canShip = shippable > 0;
    return `
    <div class="balance-card ${canShip ? '' : 'zero'}" onclick="openShipment(${b.id})">
      <div class="balance-head">
        <span class="batch-code">${esc(b.code)}</span>
        <span class="badge ${canShip ? 'active' : 'invalid'}">可出货 ${shippable}</span>
      </div>
      <div class="balance-nums">
        <span>已贴用 <b>${applied}</b></span>
        <span>已分配 <b>${allocated}</b></span>
        <span>可出货 <b class="${canShip ? 'ok-num' : ''}">${shippable}</b></span>
      </div>
      <div class="balance-rolls">
        ${rolls.length ? rolls.map((r) => {
          const avail = r.active ? Math.max(r.applied_qty - (r.allocated_qty || 0), 0) : 0;
          return `<span class="mini-roll ${r.active ? '' : 'off'}">
            ${esc(r.roll_code)}：${r.active ? `可出 ${avail}` : '已停用'}</span>`;
        }).join(' ') : '<span class="batch-meta">无标签卷</span>'}
      </div>
    </div>`;
  }).join('');

  $('#balanceList').innerHTML = cards || '<div class="batch-meta">尚无批次。</div>';
}

function renderShipments() {
  const list = state.shipments || [];
  if (!list.length) {
    $('#shipmentList').innerHTML = '<div class="batch-meta">尚无出货单。</div>';
    return;
  }
  $('#shipmentList').innerHTML = list.map((s) => {
    const cd = s.current_disposition;
    let dispBadge = '';
    if (cd) {
      if (cd.needs_review) {
        dispBadge = `<span class="badge disp-stale" title="${esc(cd.stale_reason)}">结论需重新评估：${esc(cd.decision_text)}</span>`;
      } else {
        dispBadge = `<span class="badge ${cd.decision === 'CONTINUE' ? 'disp-continue' : 'disp-recall'}">${esc(cd.decision_text)}</span>`;
      }
    }
    return `
    <div class="shipment-card ${s.status === 'PENDING_REVIEW' ? 'pending' : ''}">
      <div class="shipment-head">
        <span class="shipment-code">${esc(s.shipment_code)}</span>
        <span class="badge ${s.status === 'SHIPPED' ? 'active' : 'invalid'}">
          ${s.status === 'SHIPPED' ? '已出货' : '待评估'}
        </span>
        ${dispBadge}
        <span class="batch-meta">批次 ${esc(s.batch_code || '（已删除）')} ·
          ${esc(fmtTime(s.shipped_at))} · ${esc(s.shipped_by)}</span>
        <span class="spacer"></span>
        <span class="batch-meta">出货量 <b>${s.ship_qty}</b> 张</span>
        ${s.status === 'PENDING_REVIEW'
          ? `<button class="btn small primary" onclick="openEvaluation('${esc(s.shipment_code)}')">
               ${cd ? '查看评估 / 历史' : '质量评估处置'}</button>`
          : ''}
      </div>
      <div class="tag-row" style="margin:6px 0">
        <b class="batch-meta">出货时过敏原：</b>${allergenTags(s.allergens, '无过敏原')}
      </div>
      <table class="grid item-table">
        <thead><tr><th>卷号</th><th>分配张数</th><th>卷修订号</th>
          <th>放行标识</th><th>放行时间</th><th>放行人</th><th>放行/集合快照</th></tr></thead>
        <tbody>
          ${s.items.map((it) => `
            <tr>
              <td>${esc(it.roll_code)}</td>
              <td>${it.qty}</td>
              <td>${it.roll_revision}</td>
              <td>#${it.release_id == null ? '（已删除）' : it.release_id}</td>
              <td>${esc(fmtTime(it.release_at))}</td>
              <td>${esc(it.release_by)}</td>
              <td>${allergenTags(it.allergens, '无过敏原')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${s.status === 'PENDING_REVIEW'
        ? `<div class="shipment-review-reason">⚠ 待评估原因：${esc(s.review_reason || '—')}</div>`
        : ''}
      ${cd ? `
      <div class="disp-current ${cd.needs_review ? 'stale' : ''}">
        <b>当前质量结论：${esc(cd.decision_text)}</b>
        <span class="batch-meta">${esc(fmtTime(cd.decided_at))} · ${esc(cd.decided_by)} · 依据：${esc(cd.basis)}</span>
        ${cd.needs_review ? `<div class="disp-stale-reason">↻ 需重新评估：${esc(cd.stale_reason)}</div>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');
}

function renderEvents() {
  $('#eventList').innerHTML = state.events.map((ev) => {
    const eq = state.equipment.find((q) => q.id === ev.equipment_id);
    let body = '';
    if (ev.type === 'PROCESS') {
      const mats = ev.inputs.filter((i) => i.material_id);
      const refs = ev.inputs.filter((i) => i.ref_batch_id);
      body = `
        <div class="event-inputs"><b>产出：</b>${esc(ev.batch_code || '?')}
          ｜推导过敏原：<span class="tag-row" style="display:inline-flex">${allergenTags(ev.out_allergens)}</span>
        </div>
        <div class="event-inputs"><b>原料：</b>${mats.length ? mats.map((m) => `${esc(m.material_name)}(${esc(m.material_code)})`).join('、') : '—'}
          ｜<b>引用批次：</b>${refs.length ? refs.map((r) => esc(r.ref_batch_code)).join('、') : '—'}</div>`;
    } else {
      body = `<div class="event-inputs"><b>已核实清洗：</b>清空设备残留${ev.note ? `｜${esc(ev.note)}` : ''}</div>`;
    }
    return `
    <div class="event-item ${ev.type === 'CLEAN' ? 'clean' : ''}">
      <div class="event-head">
        <span class="event-time">${esc(fmtTime(ev.event_time))}</span>
        <span class="event-type ${ev.type}">${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}</span>
        <span class="batch-meta">${esc(eq ? `${eq.name}(${eq.code})` : '?')}</span>
        ${ev.type === 'PROCESS' && ev.note ? `<span class="batch-meta">${esc(ev.note)}</span>` : ''}
      </div>
      ${body}
      ${ev.type === 'PROCESS' ? renderPaths(ev.out_paths) : ''}
      <div class="event-actions">
        <button class="btn small" onclick="editEvent(${ev.id})">更正</button>
        <button class="btn small danger" onclick="deleteEvent(${ev.id})">删除</button>
      </div>
    </div>`;
  }).join('') || '<div class="batch-meta">尚无事件。</div>';
}

function renderBase() {
  $('#materialRows').innerHTML = state.materials.map((m) => `
    <tr>
      <td>${esc(m.code)}</td>
      <td>${esc(m.name)}</td>
      <td>${allergenTags(m.allergens, '无')}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editMaterial(${JSON.stringify(m).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteMaterial(${m.id})">删除</button>
      </td>
    </tr>`).join('');

  $('#equipmentRows').innerHTML = state.equipment.map((q) => `
    <tr>
      <td>${esc(q.code)}</td>
      <td>${esc(q.name)}</td>
      <td class="row-actions">
        <button class="btn small" onclick='editEquipment(${JSON.stringify({ id: q.id, code: q.code, name: q.name }).replace(/'/g, '&#39;')})'>编辑</button>
        <button class="btn small danger" onclick="deleteEquipment(${q.id})">删除</button>
      </td>
    </tr>`).join('');
}

// ================= Tabs =================
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $(`#tab-${t.dataset.tab}`).classList.add('active');
}));

// ================= 事件弹窗 =================
function openEventModal() {
  editingEventId = null;
  $('#eventModalTitle').textContent = '录入事件';
  const form = $('#eventForm');
  form.reset();
  form.event_time.value = new Date().toISOString().slice(0, 16);
  fillEventModalOptions(null);
  $('#processFields').style.display = form.type.value === 'PROCESS' ? 'block' : 'none';
  $('#eventModal').classList.remove('hidden');
}
window.openEventModal = openEventModal;
$('#btnNewEvent').onclick = openEventModal;
$('#btnNewEventTop').onclick = () => {
  $$('.tab').find((x) => x.dataset.tab === 'events').click();
  openEventModal();
};
$('#eventCancel').onclick = () => $('#eventModal').classList.add('hidden');
$('#evType').onchange = (e) => {
  $('#processFields').style.display = e.target.value === 'PROCESS' ? 'block' : 'none';
};
$('#eventForm').addEventListener('input', (e) => {
  if (e.target.name === 'event_time') refreshRefBatchOptions();
});

function fillEventModalOptions(ev) {
  $('#evEquipment').innerHTML = state.equipment
    .map((q) => `<option value="${q.id}" ${ev && ev.equipment_id === q.id ? 'selected' : ''}>${esc(q.name)}（${esc(q.code)}）</option>`)
    .join('');
  $('#evMaterials').innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="material_ids" value="${m.id}"
      ${ev && ev.inputs.some((i) => i.material_id === m.id) ? 'checked' : ''}>
      ${esc(m.name)} <span class="batch-meta">[${esc(m.allergens.join('/') || '无过敏原')}]</span></label>`).join('');
  refreshRefBatchOptions(ev);
}

function refreshRefBatchOptions(ev) {
  const t = $('#eventForm').event_time.value;
  const editingBatchId = ev ? ev.batch_id : null;
  // 只列出产出时间严格更早的批次（未来/同时刻由后端强制拒绝）
  const candidates = state.batches.filter((b) => {
    if (b.id === editingBatchId) return false;
    if (ev) {
      // 编辑时已选中的引用即便当前列表时间变化也保留显示
    }
    return b.produced_at && (!t || b.produced_at < t);
  });
  const selected = new Set(ev ? ev.inputs.filter((i) => i.ref_batch_id).map((i) => i.ref_batch_id) : []);
  // 编辑场景下已引用但时间不再满足的批次也显示，由后端报错提示
  if (ev) {
    for (const b of state.batches) {
      if (selected.has(b.id) && !candidates.includes(b)) candidates.push(b);
    }
  }
  $('#evBatches').innerHTML = candidates.length ? candidates.map((b) => `
    <label><input type="checkbox" name="ref_batch_ids" value="${b.id}" ${selected.has(b.id) ? 'checked' : ''}>
      ${esc(b.code)} <span class="batch-meta">(${esc(fmtTime(b.produced_at))})</span></label>`).join('')
    : '<small class="hint">所选时间之前没有可引用的批次</small>';
}

window.editEvent = function (id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  editingEventId = id;
  $('#eventModalTitle').textContent = `更正事件 #${id}（${ev.type === 'PROCESS' ? '加工' : '已核实清洗'}）`;
  const form = $('#eventForm');
  form.type.value = ev.type;
  form.event_time.value = ev.event_time.length === 16 ? ev.event_time : ev.event_time.slice(0, 16);
  form.note.value = ev.note || '';
  form.batch_code.value = ev.batch_code || '';
  $('#processFields').style.display = ev.type === 'PROCESS' ? 'block' : 'none';
  fillEventModalOptions(ev);
  $('#eventModal').classList.remove('hidden');
};

$('#eventForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    event_time: f.event_time.value,
    type: f.type.value,
    equipment_id: parseInt(f.equipment_id.value, 10),
    note: f.note.value,
    batch_code: f.batch_code.value,
    material_ids: $$('#evMaterials input:checked').map((x) => parseInt(x.value, 10)),
    ref_batch_ids: $$('#evBatches input:checked').map((x) => parseInt(x.value, 10))
  };
  try {
    let r;
    if (editingEventId) {
      r = await api(`/api/events/${editingEventId}`, { method: 'PUT', body });
      notice('ok', '事件已更正，受影响批次与设备残留已重算');
    } else {
      r = await api('/api/events', { method: 'POST', body });
      notice('ok', '事件已录入并完成推导');
    }
    $('#eventModal').classList.add('hidden');
    await refresh();
    if (r.invalidated && r.invalidated.length) reportInvalidated(r.invalidated);
    if (r.retired_rolls && r.retired_rolls.length) reportRetiredRolls(r.retired_rolls);
    if (r.pending_shipments && r.pending_shipments.length) reportPendingShipments(r.pending_shipments);
  } catch (err) {
    notice('error', err.error || '提交失败', err.details);
  }
};

window.deleteEvent = async function (id) {
  if (!confirm('确定删除该事件？加工事件会同时删除其产出批次（整次提交仍会完整校验，失败则回滚）。')) return;
  try {
    const r = await api(`/api/events/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '事件已删除并重算');
    reportInvalidated(r.invalidated);
    reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 原料 / 设备弹窗 =================
$('#btnNewMaterial').onclick = () => {
  const f = $('#materialForm');
  f.reset(); f.id.value = '';
  $('#materialModalTitle').textContent = '新增原料';
  $('#materialModal').classList.remove('hidden');
};
window.editMaterial = (m) => {
  const f = $('#materialForm');
  f.id.value = m.id; f.code.value = m.code; f.name.value = m.name;
  f.allergens.value = m.allergens.join(',');
  $('#materialModalTitle').textContent = '编辑原料';
  $('#materialModal').classList.remove('hidden');
};
$('#materialForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    code: f.code.value, name: f.name.value,
    allergens: f.allergens.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  };
  try {
    if (f.id.value) {
      const r = await api(`/api/materials/${f.id.value}`, { method: 'PUT', body });
      await refresh();
      notice('ok', '原料已更新并重算');
      reportInvalidated(r.invalidated);
      reportRetiredRolls(r.retired_rolls);
      reportPendingShipments(r.pending_shipments);
    } else {
      await api('/api/materials', { method: 'POST', body });
      await refresh();
      notice('ok', '原料已新增');
    }
    $('#materialModal').classList.add('hidden');
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteMaterial = async (id) => {
  if (!confirm('删除该原料？已被事件引用的原料不允许删除。')) return;
  try { await api(`/api/materials/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$('#btnNewEquipment').onclick = () => {
  const f = $('#equipmentForm');
  f.reset(); f.id.value = '';
  $('#equipmentModalTitle').textContent = '新增设备';
  $('#equipmentModal').classList.remove('hidden');
};
window.editEquipment = (q) => {
  const f = $('#equipmentForm');
  f.id.value = q.id; f.code.value = q.code; f.name.value = q.name;
  $('#equipmentModalTitle').textContent = '编辑设备';
  $('#equipmentModal').classList.remove('hidden');
};
$('#equipmentForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { code: f.code.value, name: f.name.value };
  try {
    if (f.id.value) await api(`/api/equipment/${f.id.value}`, { method: 'PUT', body });
    else await api('/api/equipment', { method: 'POST', body });
    $('#equipmentModal').classList.add('hidden');
    await refresh();
  } catch (err) { notice('error', err.error || '保存失败', err.details); }
};
window.deleteEquipment = async (id) => {
  if (!confirm('删除该设备？其下仍有事件时不允许删除。')) return;
  try { await api(`/api/equipment/${id}`, { method: 'DELETE' }); await refresh(); }
  catch (err) { notice('error', err.error || '删除失败', err.details); }
};

$$('[data-close]').forEach((b) => b.onclick = (e) => e.target.closest('.modal').classList.add('hidden'));
// 弹窗内容为动态渲染（如质量处置），用事件委托保证任意 [data-close] 都可关闭。
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close]');
  if (btn) btn.closest('.modal').classList.add('hidden');
});

// ================= 放行 =================
window.openRelease = function (batchId) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) return;
  const f = $('#releaseForm');
  f.batch_id.value = b.id;
  f.batch_code.value = b.code;
  f.released_at.value = new Date().toISOString().slice(0, 16);
  f.released_by.value = '';
  $('#releaseAllergens').innerHTML = allergenTags(b.allergens);
  $('#releaseModal').classList.remove('hidden');
};
$('#releaseForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/releases', {
      method: 'POST',
      body: {
        batch_id: parseInt(f.batch_id.value, 10),
        released_at: f.released_at.value,
        released_by: f.released_by.value
      }
    });
    $('#releaseModal').classList.add('hidden');
    await refresh();
    notice('ok', '放行已按当时推导结果登记');
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};
window.deleteRelease = async (id) => {
  if (!confirm('删除该放行记录？其名下仍有效的过敏原标签卷将被永久停用（余量冻结、已贴待复核），相关已出货单将转为待评估。')) return;
  try {
    const r = await api(`/api/releases/${id}`, { method: 'DELETE' });
    await refresh();
    notice('ok', '放行记录已删除');
    reportRetiredRolls(r.retired_rolls);
    reportPendingShipments(r.pending_shipments);
  } catch (err) { notice('error', err.error || '删除失败', err.details); }
};

// ================= 过敏原标签卷 =================
function batchesWithActiveRelease() {
  return state.batches.filter((b) => (b.releases || []).some((x) => x.status === 'ACTIVE'));
}

$('#btnNewRoll').onclick = () => {
  const f = $('#rollForm');
  f.reset();
  const candidates = batchesWithActiveRelease();
  $('#rollBatch').innerHTML = candidates.length
    ? candidates.map((b) => `<option value="${b.id}">${esc(b.code)}（${esc(fmtTime(b.produced_at))}）</option>`).join('')
    : '';
  $('#rollCurrent').innerHTML = candidates.length
    ? allergenTags(candidates[0].allergens)
    : '<span class="tag danger">没有存在有效放行的批次；请先在“批次与放行”登记放行</span>';
  fillRollReleaseOptions(candidates[0]);
  if (candidates[0]) {
    $('#rollAllergens').value = candidates[0].allergens.join(',');
  }
  $('#rollModal').classList.remove('hidden');
};

$('#rollBatch').onchange = (e) => {
  const b = state.batches.find((x) => x.id === parseInt(e.target.value, 10));
  $('#rollCurrent').innerHTML = b ? allergenTags(b.allergens) : '';
  fillRollReleaseOptions(b);
  if (b) $('#rollAllergens').value = b.allergens.join(',');
};

function fillRollReleaseOptions(batch) {
  const active = batch ? (batch.releases || []).filter((r) => r.status === 'ACTIVE') : [];
  $('#rollRelease').innerHTML = active.length
    ? active.map((r) => `<option value="${r.id}">${esc(fmtTime(r.released_at))} · ${esc(r.released_by)}｜快照：${esc(r.snapshot_allergens.join('、') || '无过敏原')}</option>`).join('')
    : '';
}

$('#rollRelease').onchange = () => { /* 集合展示不变；三方一致由后端强制 */ };

$('#rollForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const batch_id = parseInt(f.batch_id.value, 10);
  const body = {
    batch_id,
    release_id: parseInt(f.release_id.value, 10),
    allergens: f.allergens_text.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
    print_qty: parseInt(f.print_qty.value, 10),
    registered_by: f.registered_by.value
  };
  try {
    const r = await api('/api/label-rolls', { method: 'POST', body });
    $('#rollModal').classList.add('hidden');
    $$('.tab').find((x) => x.dataset.tab === 'labels').click();
    await refresh();
    notice('ok', `登记成功：卷号 ${r.roll_code}，印量 ${r.print_qty}，可用张数 ${r.remaining_qty}`);
  } catch (err) { notice('error', err.error || '登记失败', err.details); }
};

// 核销（事件委托，动态表单也生效）
$('#rollList').addEventListener('submit', async (e) => {
  const form = e.target.closest('.consume-form');
  if (!form) return;
  e.preventDefault();
  const rollId = form.dataset.rollId;
  const body = {
    expected_revision: parseInt(form.expected_revision.value, 10),
    applied: parseInt(form.applied.value, 10),
    voided: parseInt(form.voided.value, 10),
    used_by: form.used_by.value
  };
  try {
    const r = await api(`/api/label-rolls/${rollId}/consume`, { method: 'POST', body });
    await refresh();
    notice('ok', `核销成功：${r.roll_code} 新修订号 ${r.revision}，剩余可贴 ${r.remaining_qty} 张`);
  } catch (err) {
    notice('error', err.error || '核销被拒绝', err.details);
    await refresh(); // 修订号可能已被他人推进，刷新表单
  }
});

// ================= 包装出货 =================
function shippableRolls(batchId) {
  return (state.label_rolls || [])
    .filter((r) => r.batch_id === batchId && r.active)
    .filter((r) => {
      const b = state.batches.find((x) => x.id === batchId);
      const rel = b && (b.releases || []).find((x) => x.id === r.release_id && x.status === 'ACTIVE');
      return Boolean(rel);
    })
    .filter((r) => r.shippable_qty > 0);
}

function fillShipmentModal(batchId) {
  const f = $('#shipmentForm');
  const batches = state.batches.filter((b) => shippableRolls(b.id).length > 0);
  $('#shipBatch').innerHTML = batches.length
    ? batches.map((b) =>
      `<option value="${b.id}" ${b.id === batchId ? 'selected' : ''}>${esc(b.code)}</option>`).join('')
    : '';
  renderShipAllocationRows(batchId || (batches[0] && batches[0].id));
}

function renderShipAllocationRows(batchId) {
  const rolls = batchId ? shippableRolls(batchId) : [];
  if (!rolls.length) {
    $('#shipRollsHint').innerHTML = '<span class="tag danger">该批次暂无可出货标签（需要未停用、绑定有效放行且有已贴用余额的卷）</span>';
    $('#shipAllocations').innerHTML = '';
    return;
  }
  $('#shipRollsHint').innerHTML = rolls.map((r) =>
    `<span class="mini-roll">${esc(r.roll_code)}：已贴 ${r.applied_qty} · 已分配 ${r.allocated_qty || 0} · 可出 <b>${r.shippable_qty}</b>（修订号 ${r.revision}）</span>`
  ).join(' ');
  $('#shipAllocations').innerHTML = rolls.map((r) => `
    <label class="alloc-line">
      <span class="alloc-roll">${esc(r.roll_code)}</span>
      <input type="number" min="0" max="${r.shippable_qty}" step="1" value="0"
             data-roll-id="${r.id}" data-avail="${r.shippable_qty}" class="alloc-qty">
      <small class="hint">≤ ${r.shippable_qty}</small>
    </label>`).join('');
  $('#shipAllocations').querySelectorAll('.alloc-qty').forEach((inp) => {
    inp.addEventListener('input', syncShipQty);
  });
  syncShipQty();
}

function syncShipQty() {
  const total = [...$('#shipAllocations').querySelectorAll('.alloc-qty')]
    .reduce((s, x) => s + (parseInt(x.value, 10) || 0), 0);
  $('#shipQty').value = total || '';
}

window.openShipment = function (batchId) {
  const f = $('#shipmentForm');
  f.reset();
  f.shipped_at.value = new Date().toISOString().slice(0, 16);
  fillShipmentModal(batchId);
  $('#shipmentModal').classList.remove('hidden');
};
$('#btnNewShipment').onclick = () => {
  const first = state.batches.find((b) => shippableRolls(b.id).length > 0);
  openShipment(first ? first.id : (state.batches[0] && state.batches[0].id));
};
$('#shipBatch').onchange = (e) => {
  renderShipAllocationRows(parseInt(e.target.value, 10));
};

$('#shipmentForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const batch_id = parseInt(f.batch_id.value, 10);
  const allocations = [...$('#shipAllocations').querySelectorAll('.alloc-qty')]
    .map((x) => ({ roll_id: parseInt(x.dataset.rollId, 10), qty: parseInt(x.value, 10) || 0 }))
    .filter((a) => a.qty > 0);
  const body = {
    batch_id,
    ship_qty: parseInt(f.ship_qty.value, 10),
    shipped_by: f.shipped_by.value,
    shipped_at: f.shipped_at.value || undefined,
    allocations
  };
  try {
    const r = await api('/api/shipments', { method: 'POST', body });
    $('#shipmentModal').classList.add('hidden');
    $$('.tab').find((x) => x.dataset.tab === 'shipments').click();
    await refresh();
    notice('ok', `出货确认成功：单号 ${r.shipment_code}，状态「已出货」，共 ${r.ship_qty} 张`);
  } catch (err) { notice('error', err.error || '出货被拒绝（整单未占用数量）', err.details); }
};

// ================= 出货质量处置（整单） =================
let evalContext = null; // 最近一次查询取得的评估视图（含签名状态版本）

function conditionRow(ok, text) {
  return `<li class="${ok ? 'cond-ok' : 'cond-bad'}">${ok ? '✓' : '✗'} ${esc(text)}</li>`;
}

window.openEvaluation = async function (codeOrId) {
  try {
    evalContext = await api(`/api/shipments/${encodeURIComponent(codeOrId)}/evaluation`);
    renderEvaluation();
    $('#evaluationModal').classList.remove('hidden');
  } catch (err) {
    notice('error', err.error || '加载评估视图失败', err.details);
  }
};

function renderEvaluation() {
  const ev = evalContext;
  const s = ev.shipment;
  const c = ev.conditions;
  const cur = ev.current_state;
  const curDisp = ev.current_disposition;
  const blocked = !ev.review.reviewable || (curDisp && curDisp.active);

  const rollRows = cur.used_rolls.map((r) => `
    <tr>
      <td>${esc(r.roll_code || ('#' + r.roll_id))}</td>
      <td>${r.missing ? '<span class="tag danger">卷记录缺失</span>'
        : (r.retired ? '<span class="tag danger">已停用</span>' : '<span class="tag ok">使用中</span>')}</td>
      <td>${r.retired ? esc(r.retired_reason || '—') : '—'}</td>
      <td>${r.release_id == null ? '—（已解除/删除）' : '#' + r.release_id}
        ${r.release_exists ? (r.release_active ? '<span class="tag ok">有效</span>' : '<span class="tag danger">已失效</span>')
          : '<span class="tag danger">已删除</span>'}</td>
    </tr>`).join('');

  const historyRows = ev.history.slice().reverse().map((d) => `
    <tr class="${d.life_status === 'STALE' ? 'hist-stale' : ''}">
      <td>#${d.id}</td>
      <td>${d.decision === 'CONTINUE'
        ? '<span class="tag ok">准予继续流转</span>'
        : '<span class="tag warn">召回</span>'}</td>
      <td>${esc(fmtTime(d.decided_at))}</td>
      <td>${esc(d.decided_by)}</td>
      <td>${esc(d.basis)}</td>
      <td>${d.life_status === 'STALE'
        ? `<span class="tag warn" title="${esc(d.stale_reason)}">需重新评估</span><div class="batch-meta">${esc(d.stale_reason)}</div>`
        : '<span class="tag ok">有效</span>'}</td>
    </tr>`).join('');

  $('#evalContent').innerHTML = `
    <div class="shipment-head">
      <span class="shipment-code">${esc(s.shipment_code)}</span>
      <span class="badge invalid">待评估</span>
      <span class="batch-meta">批次 ${esc(s.batch_code || '（批次已删除）')} ·
        ${esc(fmtTime(s.shipped_at))} · ${esc(s.shipped_by)} · 出货 ${s.ship_qty} 张</span>
    </div>
    <div class="shipment-review-reason">⚠ 待评估原因：${esc(ev.review.review_reason || '—')}</div>

    <div class="eval-grid">
      <div class="eval-col">
        <h4>出货当时（快照，不变）</h4>
        <div class="tag-row" style="margin:4px 0 8px">
          <b class="batch-meta">过敏原：</b>${allergenTags(ev.shipment_snapshot.allergens, '无过敏原')}
        </div>
        <table class="grid item-table">
          <thead><tr><th>卷号</th><th>张数</th><th>修订号</th><th>放行</th><th>放行快照过敏原</th></tr></thead>
          <tbody>${ev.shipment_snapshot.items.map((it) => `
            <tr><td>${esc(it.roll_code)}</td><td>${it.qty}</td><td>${it.roll_revision}</td>
              <td>${it.release_id == null ? '—' : '#' + it.release_id + ' ' + esc(fmtTime(it.release_at)) + ' ' + esc(it.release_by)}</td>
              <td>${allergenTags(it.allergens, '无')}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="eval-col">
        <h4>当前状态</h4>
        <div class="batch-meta" style="margin:4px 0">
          批次：${cur.batch_exists ? esc(cur.batch_code) : '<span class="tag danger">批次已不存在</span>'}
        </div>
        <div class="tag-row" style="margin:4px 0">
          <b class="batch-meta">当前批次过敏原：</b>
          ${cur.batch_exists ? allergenTags(cur.batch_allergens, '无过敏原') : '<span class="tag none">无法推导</span>'}
        </div>
        <div style="margin:6px 0">
          <b class="batch-meta">当前有效放行（${cur.active_releases.length}）：</b>
          ${cur.active_releases.length
            ? cur.active_releases.map((r) =>
              `<span class="tag ok">#${r.id} ${esc(fmtTime(r.released_at))} ${esc(r.released_by)}｜${esc(r.snapshot_allergens.join('、') || '无')}</span>`).join('')
            : '<span class="tag danger">无有效放行</span>'}
        </div>
        <table class="grid item-table">
          <thead><tr><th>所用卷</th><th>当前状态</th><th>停用原因</th><th>绑定放行</th></tr></thead>
          <tbody>${rollRows}</tbody>
        </table>
      </div>
    </div>

    <div class="cond-box ${c.can_continue ? 'can' : 'cannot'}">
      <b>${c.can_continue ? '满足“准予继续流转”条件' : '不满足“准予继续流转”，只能召回'}</b>
      <ul class="cond-list">
        ${conditionRow(c.batch_exists, '批次仍存在且可重新推导过敏原')}
        ${conditionRow(c.has_active_release, '当前有有效放行记录')}
        ${conditionRow(c.snapshot_covers_current,
          '出货快照覆盖当前过敏原' + (c.uncovered_allergens.length
            ? `（未覆盖：${c.uncovered_allergens.join('、')}）` : ''))}
      </ul>
    </div>

    ${curDisp && curDisp.active ? `
      <div class="disp-current">
        <b>已有有效结论：${esc(curDisp.decision_text)}</b>
        <span class="batch-meta">${esc(fmtTime(curDisp.decided_at))} · ${esc(curDisp.decided_by)} · 依据：${esc(curDisp.basis)}</span>
        <div class="batch-meta">处置记录只增不改，不能重复提交覆盖；待该结论被标为“需重新评估”后才可再次登记。</div>
      </div>` : `
    <form id="dispositionForm" class="disp-form">
      <input type="hidden" name="version" value="${esc(ev.version)}">
      <div class="form-row align-top">
        <label>处置结论 <span class="req">*</span></label>
        <div class="decision-pick">
          <label><input type="radio" name="decision" value="CONTINUE" ${c.can_continue ? '' : 'disabled'}>
            <span>准予继续流转</span>${c.can_continue ? '' : '<small class="hint">（当前条件不满足，不可选）</small>'}</label>
          <label><input type="radio" name="decision" value="RECALL" checked>
            <span>召回</span></label>
        </div>
      </div>
      <div class="form-row">
        <label>提交操作人 <span class="req">*</span></label>
        <input type="text" name="decided_by" placeholder="姓名/工号" required>
      </div>
      <div class="form-row align-top">
        <label>处置依据 <span class="req">*</span></label>
        <textarea name="basis" rows="2" required placeholder="如：核实新增过敏原为误投料/现场复检结果/召回决定文件号…"></textarea>
      </div>
      <div class="form-row">
        <label>处置时间</label>
        <input type="datetime-local" name="decided_at">
      </div>
      <div class="batch-meta">
        状态版本 <code>${ev.status_version}</code>（查询时取得，30 分钟内有效；提交事务内核对，过期将拒绝且不产生记录）
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>关闭</button>
        <button type="submit" class="btn primary">提交整单处置（事务校验，记录只增不改）</button>
      </div>
    </form>`}

    <h4 style="margin-top:14px">处置历史（只增不改）</h4>
    ${historyRows ? `
    <table class="grid item-table">
      <thead><tr><th>#</th><th>结论</th><th>时间</th><th>操作人</th><th>依据</th><th>生命周期</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>` : '<div class="batch-meta">尚无处置记录。</div>'}
    <div class="modal-actions">
      <button type="button" class="btn" data-close>关闭</button>
    </div>
  `;
}

$('#evaluationModal').addEventListener('submit', async (e) => {
  const form = e.target.closest('#dispositionForm');
  if (!form) return;
  e.preventDefault();
  const decisionEl = form.querySelector('input[name=decision]:checked');
  const body = {
    decision: decisionEl ? decisionEl.value : 'RECALL',
    decided_by: form.decided_by.value.trim(),
    basis: form.basis.value.trim(),
    decided_at: form.decided_at.value || undefined,
    version: form.version.value
  };
  const code = evalContext && evalContext.shipment && evalContext.shipment.shipment_code;
  try {
    const r = await api(`/api/shipments/${encodeURIComponent(code)}/dispositions`,
      { method: 'POST', body });
    evalContext = r.evaluation;
    renderEvaluation();
    await refresh();
    notice('ok', `处置已登记：${r.disposition.decision_text}（记录只增不改；出货单原状态与数量占用不变）`);
  } catch (err) {
    notice('error', err.error || '处置提交被拒绝（未产生记录）', err.details);
    // 版本可能已过期或被并发改动：重新查询最新评估视图
    if (['VERSION_EXPIRED', 'VERSION_INVALID', 'DISPOSITION_EXISTS'].includes(err.code)) {
      try { evalContext = await api(`/api/shipments/${encodeURIComponent(code)}/evaluation`); renderEvaluation(); }
      catch (_) { /* ignore */ }
    }
  }
});

// ================= 启动 =================
refresh().catch((err) => notice('error', '加载状态失败', err.message || String(err)));
