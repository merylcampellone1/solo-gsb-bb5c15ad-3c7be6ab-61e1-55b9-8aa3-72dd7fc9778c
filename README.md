# 食品加工换线 · 过敏原追踪与放行系统

本地运行的食品加工过敏原追溯网页：录入**原料过敏原、设备、按时间排序的加工事件与已核实清洗事件**，
系统按时间顺序推导每个产出批次的过敏原集合及来源路径，管理设备残留，支持按**当时推导结果**登记批次放行，
并在**包装前按批次 + 有效放行登记过敏原标签卷**（按修订号核销贴用/作废，集合或放行变化时永久停用），
**包装出货时按批次把已贴用标签卷分配给出货单**（整单事务校验，卷停用时相关已出货单转待评估、不自动恢复），
**待评估出货单由质检按整单登记“准予继续流转/召回”处置**（凭查询状态版本事务核对，记录只增不改；
此后过敏原/有效放行/停卷信息变化时旧结论保留并标需重新评估、不自动生效）。

- 后端：Node.js + Express
- 数据库：SQLite（[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据文件本地保存）
- 前端：浏览器单页应用（原生 HTML/CSS/JS，无需构建）

## 功能与规则

### 推导规则

- **批次产出过敏原** = 全部原料输入过敏原 ∪ 引用的此前批次产出 ∪ **设备当前残留**，并集计算。
- **设备残留更新**：每次加工后，该设备残留更新为本次产出的过敏原集合；新鲜来源路径会追加“设备残留”标记，
  已在残留中的路径原样保留（可追溯残留自哪次加工带入）。
- **已核实清洗**（CLEAN 事件）才会清空对应设备的残留；普通加工不会清空。
- 每个批次的每个过敏原都展示**来源路径链**，例如：
  `原料:全脂奶粉(MILK-01) → 批次引用:BATCH-002 → 设备残留:LINE-A`
- 更正/删除早期事件后，系统**全量重算**所有受影响的后续批次与设备残留。

### 放行

- 放行以登记时刻的过敏原集合作为**快照**保存。
- 早期事件更正后重算：某条放行登记时的集合与新结果**不同**，该放行自动置为**已失效**，
  页面红色标注并给出具体原因（新增了哪些过敏原 / 移除了哪些过敏原）；失效为终态，需重新登记放行。
- 集合相同则放行保持有效。

### 提交约束（整次提交事务化，违反任意一条则整单回滚拒绝）

- 加工只能引用**产出时间严格更早**的批次——引用未来批次被拒绝。
- 批次引用关系**形成循环**被拒绝。
- **同一设备同一时刻**存在多条事件（时间冲突）被拒绝。
- 同一批次不能被两次加工产出。

### 换线整组预演与确认应用（本轮新增）

车间调整加工顺序时，可**一次提交多条既有事件的更正（PROCESS/CLEAN）与拟插入的清洗事件**：

- `POST /api/replan/preview` 在**内存影子库**上应用整组变更，按整组变更后的时间线
  全量校验（引用先后、引用环、设备时间冲突、批次唯一产出）并重算，返回应用前后
  **每批过敏原、设备残留、将失效的放行记录**差异；**不修改正式事件、推导结果或放行状态**。
- **单条更正单独看暂时冲突、但整组最终合法时仍可预演**（例如交换两个事件的时间）。
- 预演返回业务版本 `version`（签名令牌，30 分钟有效；服务重启后旧版本作废）。
- `POST /api/replan/apply` 确认应用：**必须携带预演版本及与预演完全相同的 changes**，
  在**一次事务**中重新校验版本、重新做全量校验并重算落库。
- **预演后任何会影响这些结果的正式写入**（新增/更正/删除事件、改原料过敏原、登记/删除放行等）
  **均使该版本过期**：应用返回 `409 VERSION_EXPIRED` 且**原状态不变**，需重新预演。
- 以下情况在预演阶段即明确拒绝（HTTP 400，`details` 给出逐条中文原因，预演失败可见原因）：
  未知事件、同一事件被重复更正、设备不存在、拟插入的清洗事件缺少时间、
  整组后时间线非法（未来引用 / 引用环 / 时间冲突 / 批次重复产出）等。

> 既有单条事件接口（`POST/PUT/DELETE /api/events/...`）与放行接口（`/api/releases`）
> 的语义完全保持不变；新接口只做“整组预演 + 确认应用”。

#### 变更项格式（`changes` 数组，顺序无关）

更正既有事件（字段与单条 `PUT /api/events/:id` 相同，必须带 `type`；加工事件为全量覆盖输入/引用）：

```json
{
  "op": "update",
  "event_id": 1,
  "type": "PROCESS",
  "event_time": "2026-09-30T09:00",
  "equipment_id": 1,
  "note": "早班面团（改到清洗后）",
  "batch_code": "BATCH-001",
  "material_ids": [1, 7],
  "ref_batch_ids": []
}
```

拟插入的清洗事件（`client_key` 可选，便于多条时对应预演返回的新事件 id）：

```json
{ "op": "insert_clean", "client_key": "mid-wash", "event_time": "2026-09-30T09:30",
  "equipment_id": 1, "note": "换线中间追加一次已核实清洗" }
```

#### 调用示例（curl，基于演示数据）

```bash
# 1) 预演：交换 LINE-A 上 BATCH-001(08:00) 与清洗(09:00) 的时间
curl -s -X POST http://localhost:3000/api/replan/preview \
  -H 'Content-Type: application/json' -d '{
    "changes": [
      {"op":"update","event_id":1,"type":"PROCESS","event_time":"2026-09-30T09:00",
       "equipment_id":1,"note":"早班面团","batch_code":"BATCH-001",
       "material_ids":[1,7],"ref_batch_ids":[]},
      {"op":"update","event_id":2,"type":"CLEAN","event_time":"2026-09-30T08:00",
       "equipment_id":1,"note":"换线前已核实清洗"}
    ]
  }'
# -> { ok:true, phase:"PREVIEW", version:"<业务版本令牌>", business_version:"...",
#      changes:[...规范化回显...], inserted_clean_events:[],
#      diff:{ summary:{ batches_changed, equipment_residue_changed,
#                       releases_will_invalidate, releases_changed },
#             batches:[{batch_id,code,produced_at,
#                       before_allergens,after_allergens,added,removed}],
#             equipment_residue:[{equipment_id,equipment_code,
#                       before_allergens,after_allergens,added,removed,
#                       before_last_cleaned_at,after_last_cleaned_at}],
#             releases:[{release_id,batch_code,before_status,after_status:"INVALIDATED",
#                       after_invalid_reason,...}] } }

# 2) 确认应用：原样回传 version 与同一份 changes（事务内重新校验+重算）
curl -s -X POST http://localhost:3000/api/replan/apply \
  -H 'Content-Type: application/json' -d '{
    "version": "<上一步返回的 version>",
    "changes": [ ...与预演完全相同的内容... ]
  }'
# -> { ok:true, phase:"APPLIED", applied_version, business_version,
#      inserted_clean_events:[{client_key,event_id}], invalidated:[...],
#      diff:{ ...与预演同结构的实际落库差异... } }
```

预演失败示例（整组后时间线非法，HTTP 400）：

```json
{ "error": "整组变更应用后的时间线校验未通过",
  "code": "REPLAN_REJECTED",
  "details": ["事件 #3（2026-09-30T11:30）引用了未来或同时刻批次 #4（产出时间 2026-09-30T11:00），不允许引用未来批次"] }
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 请求体/变更内容问题（非数组、缺时间、未知事件、重复更正、设备不存在…） | 400 | `INVALID_REQUEST` / `REPLAN_REJECTED` |
| 整组后时间线校验失败（未来引用/环/时间冲突/批次重复产出） | 400 | `REPLAN_REJECTED` |
| 版本签名损坏或格式非法 | 400 | `VERSION_INVALID` |
| apply 的 changes 与预演不一致 | 409 | `CHANGES_MISMATCH` |
| 预演后正式数据已变更导致版本过期（含重复应用同一版本、版本过期） | 409 | `VERSION_EXPIRED` |

## 过敏原标签卷（包装前登记 → 核销贴用/作废）

包装前，按**现有批次**与其**有效放行记录**登记一卷过敏原标签：

- 登记必须录入**拟印过敏原集合**、**正整数印量（张）**与**操作人**；
  拟印集合必须与①该批次**当前推导结果**、②所选**放行快照****完全一致**（三方一致，顺序/重复不敏感），
  否则整次拒绝。登记成功返回**卷号**（`LABEL-0001` 起）与**可用张数**。
- 每卷凭**预期修订号**（`expected_revision`，登记时为 0，每次核销 +1）核销**贴用**与**作废**张数；
  累计贴用 + 作废不得超过印量。**旧修订号、负数、超量均整次拒绝**（事务回滚，修订号不前进）。
- **永久停用（终态）**：原料或加工事件变更、整组换线确认应用使该批次集合改变，
  或绑定的放行记录失效、被删除时，该卷立即永久停用——
  **余量不可再贴，已贴数量标记“待复核”**；即使过敏原集合后来恢复一致，**也不会自动解冻**，
  需在新的有效放行下登记新卷。
- “过敏原标签卷”页按**批次分组**显示每卷的**印量、贴用、作废、剩余**及**停用原因**；
  批次卡片上也有该批标签卷数量摘要，可一键跳转。
- 整组预演返回的 `diff.label_rolls_will_retire` 会列出应用后**将被永久停用**的卷（含待复核张数），
  预演本身不停用任何正式卷；确认应用的响应 `retired_rolls` 为实际停用的卷。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/label-rolls` | 登记一卷（三方一致校验），返回卷对象（含 `roll_code`、`remaining_qty`） |
| `POST /api/label-rolls/:id/consume` | 按预期修订号核销贴用/作废，返回更新后的卷对象（含新 `revision`） |
| `GET /api/state` | 顶层含 `label_rolls` 数组（既有字段不变），按批次含卷号/印量/贴用/作废/剩余/修订号/状态/停用原因；每项另含 `allocated_qty`/`shippable_qty`，顶层另含 `shipments`（见下节） |
| `DELETE /api/releases/:id` | 语义不变（仍返回 `ok:true`），另附 `retired_rolls`：其名下有效卷被永久停用 |
| 事件 `POST/PUT/DELETE`、原料 `PUT` | 响应形状不变，另附 `retired_rolls`（本次重算导致停用的卷） |

登记请求体：

```json
{ "batch_id": 3, "release_id": 1,
  "allergens": ["乳", "蛋", "芝麻"],
  "print_qty": 500,
  "registered_by": "包装组长-李雷",
  "registered_at": "2026-09-30T12:10" }
```

核销请求体（`applied`/`voided` 也可写作 `used`/`void_qty`；`expected_revision` 必传）：

```json
{ "expected_revision": 0, "applied": 100, "voided": 3,
  "used_by": "包装工-赵强", "used_at": "2026-09-30T13:05" }
```

#### 调用示例（curl，基于演示数据；演示库自带 BATCH-003 的一卷 LABEL-0001：印 500 / 贴 120 / 作废 5 / 剩 375）

```bash
# 1) 登记一卷：集合必须同时等于当前推导与放行快照
curl -s -X POST http://localhost:3000/api/label-rolls \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "release_id": 1,
    "allergens": ["乳","蛋","芝麻"],
    "print_qty": 500, "registered_by": "包装组长-李雷"
  }'
# -> { id:2, roll_code:"LABEL-0002", print_qty:500, applied_qty:0, void_qty:0,
#      remaining_qty:500, revision:0, status:"ACTIVE", active:true, ... }

# 2) 按修订号 0 核销 100 贴用 + 3 作废 -> 剩 397，修订号前进到 1
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' \
  -d '{"expected_revision":0,"applied":100,"voided":3,"used_by":"赵强"}'

# 3) 再用旧修订号 0 核销 -> 409 REVISION_MISMATCH，整次拒绝、数量不变
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":0,"applied":5,"voided":0}'
# -> { error:"修订号已过期：卷当前修订号为 1，提交的预期修订号为 0；整次拒绝",
#      code:"REVISION_MISMATCH" }

# 4) 负数 / 超量 -> 400 INVALID_REQUEST / 409 OVER_LIMIT
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":-1,"voided":0}'
curl -s -X POST http://localhost:3000/api/label-rolls/2/consume \
  -H 'Content-Type: application/json' -d '{"expected_revision":1,"applied":99999,"voided":0}'

# 5) 集合改变 / 放行失效后：卷 RETIRED，余量冻结、已贴待复核，再核销 -> 409 ROLL_RETIRED
#    （例如到“事件时间线”给 BATCH-002 加入花生原料，BATCH-003 推导集合变化）
curl -s http://localhost:3000/api/state | node -e 'let d="";process.stdin.on("data",c=>d+=c)
  .on("end",()=>{for(const r of JSON.parse(d).label_rolls)
    console.log(r.batch_code,r.roll_code,r.status,r.print_qty,r.applied_qty,r.void_qty,
      r.remaining_qty,r.retired_reason);})'

# 6) 删除放行 -> 其名下有效卷立即永久停用（响应附 retired_rolls）
curl -s -X DELETE http://localhost:3000/api/releases/1
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 拟印集合与当前推导/放行快照不一致、印量非正整数、批次或放行缺失、放行不属于该批次、放行已失效 | 400 | `ALLERGENS_MISMATCH` / `INVALID_REQUEST` / `BATCH_NOT_FOUND` / `BATCH_NOT_PRODUCED` / `RELEASE_NOT_FOUND` / `RELEASE_BATCH_MISMATCH` / `RELEASE_INACTIVE` |
| 核销：旧修订号 / 累计超印量 / 卷已停用 | 409 | `REVISION_MISMATCH` / `OVER_LIMIT` / `ROLL_RETIRED` |
| 核销：负数、全零、缺少修订号、卷号不合法 | 400 | `INVALID_REQUEST` |
| 核销不存在的卷 | 404 | `ROLL_NOT_FOUND` |

## 包装出货（按批次把已贴用标签分配给出货单）

包装出货时，按**批次**把若干**已贴用标签卷**的张数一次性分配给一张出货单：

- 出货确认必须录入：**批次**、**正整数出货量（张）**、**各卷分配张数**与**操作人**（出货时间可选，默认当前）。
- 每个被分配的卷必须同时满足：
  1. **属于该批次**；
  2. **未停用**（仍为 `ACTIVE`，未因集合改变 / 放行失效或删除而永久停用）；
  3. **绑定有效放行**（其放行记录仍存在且为 `ACTIVE`）。
- 各卷分配张数之和**必须恰好等于出货量**；每卷**累计已分配数 + 本次分配不得超过该卷已贴用数**（作废张数不算贴用）。
- **任一条件不满足，整单拒绝并事务回滚、不占用任何数量**（哪怕其中一卷合法，另一卷超量也全部回滚）。
- 成功返回**出货单号**（`SHIP-0001` 起）与**状态**（`SHIPPED` 已出货）；
  每条分配明细都保存出货**当时的放行标识（release_id 及放行时间/人快照）、过敏原集合、卷号与修订号**。
- **出货记录不可因后续更正消失**：批次行被连带删除时单据保留（批次置空、编码快照保留）；
  放行被删除时，明细里的放行标识与放行快照仍保留。
- **待评估（终态，不自动恢复）**：原料或事件变更、整组换线确认应用、或放行删除导致某卷停用时，
  **分配过该卷的已出货单全部标记为 `PENDING_REVIEW`（待评估）并显示逐卷原因**；
  即使过敏原集合后来恢复一致，单据**也不会自动恢复**为已出货（需线下质量评估，系统不提供自动回改）。
- 卷停用后，其**尚未分配的已贴张数也不得再出货**（出货只接受 `ACTIVE` 卷，余额查询中停卷可出货恒为 0）。
- 可查询**批次可出货余额**（该批所有未停用卷的「已贴用 − 累计已分配」之和）与**出货单状态/明细**。
- 已出货/待评估单据占用的分配数量始终计入「累计已分配」，不会因单据转待评估而退回重复使用。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/shipments` | 出货确认（整单事务化），返回出货单（含 `shipment_code`、`status`、各卷快照 `items`） |
| `GET /api/shipments` | 出货单列表，可按 `?batch_id=`、`?status=SHIPPED|PENDING_REVIEW` 过滤 |
| `GET /api/shipments/:idOrCode` | 单张出货单（数字 id 或 `SHIP-0001` 单号），含状态、原因与明细快照 |
| `GET /api/batches/:id/shipment-balance` | 单个批次可出货余额（逐卷列出 印量/已贴/作废/已分配/可出） |
| `GET /api/shipment-balances` | 全部批次可出货余额 |
| `GET /api/state` | 顶层新增 `shipments` 数组；`label_rolls` 每项另含 `allocated_qty`（累计已分配）与 `shippable_qty`（可出货余额） |
| 事件 `POST/PUT/DELETE`、原料 `PUT`、换线 `apply`、放行 `DELETE` | 响应形状不变，另附 `pending_shipments`（本次新转入待评估的出货单） |
| 换线 `preview` 的 `diff` | 另含 `shipments_will_pending`（应用后将转待评估的出货单）与 `summary.shipments_will_pending` |

出货请求体：

```json
{ "batch_id": 3, "ship_qty": 120, "shipped_by": "仓管-周杰",
  "shipped_at": "2026-09-30T14:20",
  "allocations": [
    { "roll_id": 1, "qty": 100 },
    { "roll_id": 2, "qty": 20 }
  ] }
```

`items[]` 明细快照字段：`roll_id` / `roll_code`（当时卷号）、`release_id`（当时放行标识）、
`release_at` / `release_by`（放行快照）、`allergens`（当时过敏原集合）、
`roll_revision`（当时卷修订号）、`qty`（本卷分配张数）。

#### 调用示例（curl，基于演示数据）

演示库自带 `BATCH-003` 的一卷 `LABEL-0001`：印 500 / 贴 120 / 作废 5 / 剩 375，
以及一张演示出货单 `SHIP-0001`（从该卷分配 100 张，修订号 2）。因此该卷**可出货余额 = 120 − 100 = 20**。

```bash
# 1) 查询批次可出货余额（逐卷：已贴/已分配/可出）
curl -s http://localhost:3000/api/batches/3/shipment-balance
# -> { batch_id:3, batch_code:"BATCH-003", shippable_qty:20,
#      applied_qty:120, allocated_qty:100,
#      rolls:[{ roll_code:"LABEL-0001", status:"ACTIVE",
#               applied_qty:120, allocated_qty:100, available_qty:20, ... }] }

# 2) 出货确认：把剩余 20 张分配给一张出货单（整单事务）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 20, "shipped_by": "仓管-周杰",
    "allocations": [ { "roll_id": 1, "qty": 20 } ]
  }'
# -> { shipment_code:"SHIP-0002", status:"SHIPPED", ship_qty:20, allocated_qty:20,
#      allergens:["蛋","乳","芝麻"],
#      items:[{ roll_code:"LABEL-0001", release_id:1,
#               release_at:"2026-09-30T11:30", release_by:"质检员-王敏",
#               allergens:["蛋","乳","芝麻"], roll_revision:2, qty:20 }] }

# 3) 余额已为 0，再分配 → 409 OVER_APPLIED，整单拒绝、不占用
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 1, "shipped_by": "仓管-周杰",
    "allocations": [ { "roll_id": 1, "qty": 1 } ]
  }'
# -> { error:"卷 LABEL-0001 可出货（已贴用）120 张，此前累计已分配 120 张，本次再分配 1 张后为 121 张，超过已贴用数；整单拒绝、不占用数量",
#      code:"OVER_APPLIED" }

# 4) 各卷之和 ≠ 出货量 → 400 ALLOCATION_MISMATCH（同样不占用）
curl -s -X POST http://localhost:3000/api/shipments \
  -H 'Content-Type: application/json' -d '{
    "batch_id": 3, "ship_qty": 21, "shipped_by": "周杰",
    "allocations": [ { "roll_id": 1, "qty": 20 } ]
  }'

# 5) 查询出货单状态：按单号 / 按状态 / 按批次
curl -s http://localhost:3000/api/shipments/SHIP-0001
curl -s 'http://localhost:3000/api/shipments?status=PENDING_REVIEW'
curl -s 'http://localhost:3000/api/shipments?batch_id=3'

# 6) 原料/事件变更或删除放行导致卷停用后：相关已出货单 PENDING_REVIEW（不自动恢复）
#    例如到“事件时间线”给 BATCH-002 加入花生原料（经设备残留/引用传播到 BATCH-003），
#    事件更正响应会附 pending_shipments；再查 SHIP-0001：
curl -s http://localhost:3000/api/shipments/SHIP-0001
# -> { status:"PENDING_REVIEW", pending_review:true,
#      review_reason:"出货所用标签卷已停用，相关已出货标签需质量评估：卷 LABEL-0001：批次过敏原集合已改变（新增：花生）…",
#      items:[ ...快照仍在... ] }
# 该卷尚未分配的已贴张数此时余额为 0，不可再出货；撤销改动集合恢复后单据仍为 PENDING_REVIEW。
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 缺批次 / 出货量或分配张数非正整数 / 缺操作人 / 空分配 / 同一卷重复分配 / 出货时间格式错 | 400 | `INVALID_REQUEST` |
| 批次不存在（出货 / 余额查询） | 400 | `BATCH_NOT_FOUND` |
| 卷不属于该批次 | 400 | `ROLL_BATCH_MISMATCH` |
| 各卷分配之和 ≠ 出货量 | 400 | `ALLOCATION_MISMATCH` |
| 卷已停用（含其未分配已贴张数再出货） | 409 | `ROLL_RETIRED` |
| 卷绑定的放行已失效 / 已删除 | 409 | `RELEASE_INACTIVE` |
| 某卷累计已分配将超过已贴用数 | 409 | `OVER_APPLIED` |
| 被分配的卷不存在 | 404 | `ROLL_NOT_FOUND` |
| 出货单不存在（按 id / 单号查询） | 404 | `SHIPMENT_NOT_FOUND` |
| 列表 `status` 取值非法 | 400 | `INVALID_REQUEST` |

## 待评估出货单的质量处置（整单结论，本轮新增）

已转为**待评估（PENDING_REVIEW）**的出货单，质检人员按**整单**登记处置结论：
**准予继续流转（CONTINUE）**或**召回（RECALL）**。

- 提交必须录入：**处置结论**、**操作人**、**依据**，以及**查询评估视图时取得的状态版本**（处置时间可选，默认当前）。
- 评估查询同时呈现：
  - **出货当时**：过敏原集合、**逐卷分配明细与放行快照**（卷号/修订号/放行标识/放行人/时间）；
  - **当前**：批次过敏原、**当前有效放行**列表、**所用各卷当前状态与停用原因**；
  - **准予条件判定**：三条条件逐项 ✓/✗ 及未覆盖的过敏原。
- **准予继续流转仅在三条同时成立时允许**：① 批次仍存在且可重新推导；② 当前有有效放行；
  ③ **出货快照覆盖当前过敏原**（当前集合是出货声明集合的子集，未声明项会逐条列出）。任一不满足，只能**召回**。
- 提交在**一次事务**内重新核对：版本签名与有效期、该单**最新状态版本**、**最新上下文指纹**
  （批次过敏原/有效放行/所用卷停用）。过期或查询后已被改动 → `409 VERSION_EXPIRED`，**拒绝且不产生记录**。
- **记录只增不改**：同一单已有**有效（ACTIVE）结论**时重复提交一律拒绝
  （`409 DISPOSITION_EXISTS`，**用旧版本也不能覆盖新结论**）；处置行从不修改结论内容。
- 此后**批次过敏原、有效放行或所用卷停用信息变化**时（事件/原料更正、整组换线确认应用、放行新增或删除），
  系统把仍为 ACTIVE 的旧结论标为 **STALE（需重新评估）**并给出具体原因：
  **旧结论与依据原样保留、不自动生效**，需重新查询、重新登记；STALE 后允许提交新结论（新记录另增一行）。
- 处置**不改变**出货单原状态（仍是待评估，不自动恢复为已出货）、**不退回数量占用**，停卷/余额规则保持不变。
- 页面“包装出货”页对待评估单显示当前结论徽标（准予/召回/**需重新评估**），
  点开可查看快照对比、条件判定、提交处置并浏览**当前结论与历史**。

### 状态版本（乐观并发）

- 状态版本为**每单单调递增整数**（出货时 0；转待评估 +1；每次登记处置 +1），
  评估视图同时返回一枚 **HMAC 签名令牌**（30 分钟有效；**服务重启后旧令牌作废**）与短码 `context_version`。
- 查询后若该单状态版本被推进（他人先处置、单据新转待评估）或上下文指纹变化，
  旧令牌提交即拒绝；处置成功后旧令牌立即失效。

### HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/shipments/:idOrCode/evaluation` | 评估视图：出货快照、当前状态、三条件判定、签名状态版本、当前结论与历史 |
| `POST /api/shipments/:idOrCode/dispositions` | 提交整单处置（事务内核版本与条件；过期不产生记录；只增不改） |
| `GET /api/shipments/:idOrCode`、`GET /api/shipments`、`GET /api/state` | 字段形状不变，出货单另附 `current_disposition`（当前结论摘要）与 `disposition_count` |
| 事件 `POST/PUT/DELETE`、原料 `PUT`、放行 `POST/DELETE`、换线 `apply` | 响应形状不变，另附 `stale_dispositions`（本次被标为需重新评估的结论） |
| 换线 `preview` 的 `diff` | 另含 `dispositions_will_stale`（应用后将需重评的结论）与 `summary.dispositions_will_stale` |

处置请求体：

```json
{ "decision": "CONTINUE", "decided_by": "质检员-陈静",
  "basis": "核实为误投料，现场复检过敏原为蛋/乳/芝麻，新放行 #2 有效，准予继续流转",
  "version": "<GET evaluation 返回的 version 令牌>",
  "decided_at": "2026-10-01T09:00" }
```

`decision` 取值：`CONTINUE`（准予继续流转）/ `RECALL`（召回，大写；时间可省略）。

#### 调用示例（curl，基于演示数据）

演示库的 `SHIP-0001` 为已出货状态；先让其转待评估（给 `BATCH-002` 加入花生原料，
`BATCH-003` 新增“花生”、原放行失效、`LABEL-0001` 停用，出货单转待评估），再评估：

```bash
# 1) 查询评估视图：取得状态版本、看三条件与所用卷停用原因
curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation
# -> { shipment:{...}, review:{pending_review:true, review_reason:"..."},
#      shipment_snapshot:{ allergens:["蛋","乳","芝麻"], items:[{roll_code:"LABEL-0001",
#          roll_revision:2, release_id:1, release_at, release_by, qty:100, ...}] },
#      current_state:{ batch_exists:true, batch_code:"BATCH-003",
#          batch_allergens:["蛋","花生","乳","芝麻"], active_releases:[],
#          used_rolls:[{roll_code:"LABEL-0001", status:"RETIRED",
#                       retired_reason:"绑定放行已失效：…（新增：花生）…",
#                       release_exists:true, release_active:false}] },
#      conditions:{ batch_exists:true, has_active_release:false,
#          snapshot_covers_current:false, uncovered_allergens:["花生"],
#          can_continue:false, only_recall:true, blockers:[...] },
#      status_version:1, context_version:"8a2ca8bc70ee", version:"<签名令牌>",
#      current_disposition:null, history:[] }

# 2) 条件不满足时尝试 CONTINUE → 409 CONTINUE_NOT_ALLOWED（details 逐条中文原因）
VER=$(curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).version')
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' -d "{\"decision\":\"CONTINUE\",\"decided_by\":\"陈静\",\"basis\":\"复检无异常\",\"version\":\"$VER\"}"
# -> { error:"当前不满足“准予继续流转”的条件，只能登记召回（RECALL）",
#      code:"CONTINUE_NOT_ALLOWED",
#      details:["出货快照未覆盖当前批次过敏原（当前新增未声明：花生），…","当前没有有效放行记录，…"] }

# 3) 召回：提交操作人、依据与查询版本 → 落账（只增），出货单仍待评估、数量仍占用
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' \
  -d "{\"decision\":\"RECALL\",\"decided_by\":\"质检员-陈静\",
       \"basis\":\"新增花生未在出货标签声明且原放行失效，整批召回\",\"version\":\"$VER\"}"
# -> { ok:true, disposition:{id:1, decision:"RECALL", life_status:"ACTIVE",
#                             expected_version:1, status_version:2, decided_by, basis, decided_at},
#      evaluation:{...最新评估视图...} }

# 4) 重复提交（即便重新查询拿到新版本，或复用旧版本）→ 409，不能覆盖
curl -s -X POST http://localhost:3000/api/shipments/SHIP-0001/dispositions \
  -H 'Content-Type: application/json' -d "{\"decision\":\"RECALL\",\"decided_by\":\"另一人\",\"basis\":\"覆盖\",\"version\":\"$VER\"}"
# -> { error:"该出货单已存在有效的质量处置结论（召回，记录 #1）；处置记录只增不改，…",
#      code:"DISPOSITION_EXISTS" }      # 旧版本则为 VERSION_EXPIRED

# 5) 此后撤销花生改动（过敏原恢复）：旧召回结论保留并标“需重新评估”，不自动生效
#    事件更正响应附 stale_dispositions；再查评估视图：
curl -s http://localhost:3000/api/shipments/SHIP-0001/evaluation
# -> current_disposition:{ decision:"RECALL", life_status:"STALE", needs_review:true,
#                          stale_reason:"批次过敏原集合已变化（移除：花生）" }
#    history:[{id:1, decision:"RECALL", life_status:"STALE", decided_by:"质检-陈静", basis:"..."}]
#    登记新有效放行后三条件齐全 → 重新查询取新版本，可提交 CONTINUE（新增第 2 条记录，#1 原样保留）
```

| 场景 | HTTP | `code` |
| --- | --- | --- |
| 结论非法 / 缺操作人 / 缺依据 / 处置时间格式错 | 400 | `INVALID_REQUEST` |
| 版本缺失、签名损坏、与本单不匹配 | 400 | `VERSION_INVALID` |
| 出货单不存在（评估/处置） | 404 | `SHIPMENT_NOT_FOUND` |
| 非待评估单提交处置 | 409 | `SHIPMENT_NOT_REVIEWABLE` |
| 条件不满足仍提交 CONTINUE | 409 | `CONTINUE_NOT_ALLOWED`（`details` 逐条原因） |
| 版本过期（TTL/状态版本已前进/查询后上下文变化），**不产生记录** | 409 | `VERSION_EXPIRED` |
| 已有有效结论，重复提交（含旧版本）不得覆盖 | 409 | `DISPOSITION_EXISTS` |

## 一键启动（Docker，从空环境开始）

要求安装 Docker 与 Docker Compose（v2）。在项目目录执行：

```bash
docker compose up --build -d
```

该命令会依次完成：构建镜像 → 安装 npm 依赖 → 初始化 SQLite 库与表结构 →
首次启动写入演示数据 → 启动 Web 服务。

查看日志 / 停止：

```bash
docker compose logs -f
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除本地数据（恢复空白/演示初始状态）
```

## 本地直接运行（无 Docker）

要求 Node.js 20+：

```bash
npm install
npm start                      # 自动创建 data/allergen.db、建表并写入演示数据
```

可选单独初始化数据库：`npm run init-db`。

测试（不依赖外部框架，直接在临时库上跑）：

```bash
npm test             # 校验引擎：无环/成环用例
npm run test:replan  # 启动临时端口的真实服务，端到端验证整组预演/确认应用全部语义
npm run test:labels  # 启动临时端口的真实服务，端到端验证标签卷登记/核销/永久停用全部语义
npm run test:shipments # 端到端验证包装出货：余额、整单事务拒绝、快照、待评估联动与换线预测
npm run test:evaluations # 端到端验证待评估单质量处置：评估视图/版本并发/CONTINUE 条件/只增不改/需重新评估
```

## 访问地址与端口

启动后浏览器打开：

- **http://localhost:3000**

端口可通过环境变量 `PORT` 修改；使用 Compose 时可在宿主机设置
`PORT=8080 docker compose up --build`（容器内仍监听 3000，宿主机映射变为 8080，
届时访问 http://localhost:8080 ）。

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务监听端口（容器内） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/allergen.db`（本地）/ `/app/data/allergen.db`（容器） | SQLite 数据文件路径 |
| `SEED_DEMO` | `true` | 首次启动（库为空）时是否写入演示数据；`false` 则得到空白库 |

数据保存在 SQLite 文件中：本地运行位于项目 `data/` 目录；Docker 运行位于
名为 `allergen-data` 的数据卷（容器内 `/app/data`），重启与重建镜像均不丢失。

## 页面说明

- **批次与放行**：设备当前残留（含来源路径）、每个批次的推导过敏原与逐条来源路径、
  放行记录（绿色“放行有效”/红色“已失效”及失效原因），可在此登记放行；
  批次卡片底部显示该批标签卷摘要，点击直达标签卷页。
- **过敏原标签卷**：按批次分组展示每卷印量、贴用、作废、剩余及当前修订号；
  可在此包装前登记新卷、按修订号核销贴用/作废；停用卷红色标注并给出具体停用原因，
  已贴数量标注“待复核”、余量标注“冻结”。
- **包装出货**：展示各批次**可出货余额**（未停用卷的「已贴用 − 累计已分配」，点击卡片即可出货）；
  可在此录入批次、正整数出货量、各卷分配张数与操作人做整单出货确认（失败整单拒绝、不占数量），
  并列出全部出货单及其状态、逐卷明细快照（放行标识 / 过敏原 / 卷号 / 修订号）；
  **待评估**单据黄色标注并给出逐卷停用原因，不自动恢复；
  点击「质量评估处置」可查看**出货快照与当前状态对比、准予条件判定**，
  按整单提交**准予继续流转/召回**（操作人、依据、查询状态版本；过期拒绝、记录只增不改），
  页面可查**当前结论（含“需重新评估”标记）与全部历史**。
- **事件时间线**：按时间排列全部加工/清洗事件，展示输入、引用批次与推导结果；
  “更正”可修改早期事件，保存时整单校验并触发重算。
- **原料与设备**：维护原料档案（编码、名称、过敏原标签）与设备档案。

## 快速体验失效场景

1. 打开“批次与放行”，可以看到演示数据中 `BATCH-003` 已登记放行（放行有效），
   “过敏原标签卷”页有其演示卷 `LABEL-0001`（印 500、贴 120、作废 5、剩 375）。
2. 到“事件时间线”，找到 `BATCH-002`（10:00 蛋糕糊），点击“更正”并加入原料 **花生碎(PEANUT-01)**，提交。
3. 由于设备残留沿时间线传播并经 `BATCH-002` 被 `BATCH-003` 引用，重算后 `BATCH-003`
   新增过敏原“花生”，原放行记录自动变为**已失效**，`LABEL-0001` **永久停用**：
   剩余 375 张冻结不可再贴，已贴 120 张标记待复核；撤销改动使集合恢复后，该卷也不会自动解冻。
4. 在“过敏原标签卷”页尝试对停用卷核销，会收到 `ROLL_RETIRED` 拒绝；
   重新登记放行后可登记新卷继续包装。

## 目录结构

```
server/
  db.js          # SQLite 连接与表结构（导出 initSchema 供内存影子库复用）
  validation.js  # 全量校验（未来批次/循环/时间冲突/重复产出）
  recompute.js   # 推导引擎：回放事件、批次并集、设备残留、放行核对、标签卷停用核对、出货单待评估核对
  labels.js      # 过敏原标签卷：三方一致登记、按修订号核销、永久停用
  shipments.js   # 包装出货：整单事务分配、快照保存、可出货余额、待评估联动（不自动恢复）
  evaluation.js  # 待评估单质量处置：评估视图、签名状态版本、整单结论事务提交、旧结论需重评核对
  replan.js      # 整组换线：影子库预演、业务版本签名令牌、事务确认应用
  seed.js        # 首次启动演示数据（含一卷演示标签卷与一张演示出货单）
  server.js      # Express API 与静态页面（含 /api/label-rolls、/api/shipments、/api/replan/preview|apply、/api/shipments/:id/evaluation|dispositions）
public/
  index.html  styles.css  app.js
scripts/
  test-cycle.js      # 校验引擎单测
  test-replan.js     # 整组预演/确认应用端到端测试
  test-labels.js     # 标签卷登记/核销/停用端到端测试
  test-shipments.js  # 包装出货：余额/整单事务/快照/待评估联动端到端测试
  test-evaluations.js # 出货质量处置：评估视图/版本并发/CONTINUE 条件/只增不改/需重新评估端到端测试
Dockerfile  docker-compose.yml
```
