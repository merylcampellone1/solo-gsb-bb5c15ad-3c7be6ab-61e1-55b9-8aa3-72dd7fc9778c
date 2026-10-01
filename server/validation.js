'use strict';
// 全量校验：任何新增/修改/删除事件后，在同一事务内对整个事件集重新校验。
// 返回错误信息数组（中文），为空表示通过。校验失败时调用方回滚整次提交。

function validateAll(db) {
  const errors = [];

  const events = db.prepare(
    `SELECT id, event_time, type, equipment_id, batch_id
       FROM events ORDER BY event_time, id`
  ).all();

  // 1. PROCESS 必须挂批次，且同一批次只能由一次加工产出
  const batchProducer = new Map();
  for (const e of events) {
    if (e.type === 'PROCESS') {
      if (!e.batch_id) {
        errors.push(`事件 #${e.id}（${e.event_time}）缺少产出批次`);
        continue;
      }
      if (batchProducer.has(e.batch_id)) {
        errors.push(
          `批次 #${e.batch_id} 被两次加工产出（事件 #${batchProducer.get(e.batch_id)} 与 #${e.id}）`
        );
      }
      batchProducer.set(e.batch_id, e.id);
    }
  }

  // 2. 同一设备事件时间冲突（同一设备不允许同一时刻多条事件）
  const slot = new Set();
  for (const e of events) {
    const key = `${e.equipment_id}|${e.event_time}`;
    if (slot.has(key)) {
      errors.push(
        `设备 #${e.equipment_id} 在 ${e.event_time} 存在时间冲突的事件（含事件 #${e.id}）`
      );
    }
    slot.add(key);
  }

  // 3. 加工引用此前产出的批次：禁止引用未来批次、禁止形成循环
  //    以“批次由其加工事件的时间定义先后”，构造批次依赖图。
  const batchTime = new Map();          // batchId -> ISO 时间
  const batchEvent = new Map();         // batchId -> eventId
  for (const [bid, eid] of batchProducer.entries()) {
    const ev = events.find((x) => x.id === eid);
    batchTime.set(bid, ev.event_time);
    batchEvent.set(bid, eid);
  }

  const edges = new Map();              // 当前批次 -> 被引用批次
  const inputRows = db.prepare(
    `SELECT pi.event_id, pi.batch_id AS ref_batch
       FROM process_inputs pi WHERE pi.batch_id IS NOT NULL`
  ).all();
  const eventById = new Map(events.map((e) => [e.id, e]));
  for (const row of inputRows) {
    const ev = eventById.get(row.event_id);
    if (!ev || ev.type !== 'PROCESS' || !ev.batch_id) continue;
    if (!batchProducer.has(row.ref_batch)) {
      errors.push(`事件 #${ev.id} 引用了不存在或已无加工记录的批次 #${row.ref_batch}`);
      continue;
    }
    if (row.ref_batch === ev.batch_id) {
      errors.push(`批次 #${ev.batch_id} 不能引用自身`);
      continue;
    }
    const tProducer = batchTime.get(ev.batch_id);
    const tRef = batchTime.get(row.ref_batch);
    if (tRef >= tProducer) {
      errors.push(
        `事件 #${ev.id}（${tProducer}）引用了未来或同时刻批次 #${row.ref_batch}（产出时间 ${tRef}），不允许引用未来批次`
      );
    }
    if (!edges.has(ev.batch_id)) edges.set(ev.batch_id, new Set());
    edges.get(ev.batch_id).add(row.ref_batch);
  }

  // 环检测（DFS）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const cycleBatches = new Set();
  function dfs(node, stack) {
    color.set(node, GRAY);
    for (const next of edges.get(node) || []) {
      if (color.get(next) === GRAY) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        cycle.forEach((b) => cycleBatches.add(b));
      } else if (color.get(next) !== BLACK) {
        dfs(next, stack.concat(next));
      }
    }
    color.set(node, BLACK);
  }
  for (const b of edges.keys()) {
    if (color.get(b) !== BLACK) dfs(b, [b]);
  }
  for (const b of cycleBatches) {
    errors.push(`批次 #${b} 的引用关系形成循环，拒绝提交`);
  }

  return errors;
}

module.exports = { validateAll };
