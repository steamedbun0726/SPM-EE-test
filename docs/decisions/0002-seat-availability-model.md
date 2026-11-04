# ADR-0002：座位可用性模型 —— 分离「物理状态」与「时段占用」

- 状态：提议（待组内评审；影响 M1 / M3 / D，需三人确认）
- 日期：2026-10-21
- 提出：M2 组
- 关联：与 `docs/backend-contracts.md` 中「Seat.status = occupied_by_room」的约定冲突，本 ADR 通过后以本文为准
- 前置：本项目脚手架（commit `3359756`）为一次性生成的原型，未经评审。本 ADR 将其视为可丢弃的原型，按结论重做相关链路

## 1. 背景

### 1.1 现状

脚手架对座位可用性的建模是：

- `Seat.status ∈ {available, maintenance, occupied_by_room}`
- M2 最终一级审批通过时，把该教室**全部** `available` 座位改为 `occupied_by_room`，并记 `statusSource = 'M2'`
  （`backend/src/modules/m2-rooms/room-requests.service.ts:163-169`）
- M1 搜索与预约都硬性要求 `status = 'available'`
  （`backend/src/modules/m1-seats/reservations.service.ts:98-99`、`:145`）
- 只有驳回、撤销、超时才会释放（`releaseRoom`）

### 1.2 问题

**问题一：`Seat` 没有时间维度。** `status` 是座位的全局属性，但「能否预约」本质是 `(座位, 日期, 时段)` 三元组的函数。一次「10 月 24 日 10:00–12:00」的整教室审批，会让该教室所有座位在**所有日期**都不可预约；正常使用完毕也不会释放，因为没有对应的结束事件。

**问题二：两条并行的可用性判据。** M1 的冲突检测其实已经按「`spaceId` + `date` + 时段重叠 + `RoomBookingRequest.status = 'approved'`」做过一次判断
（`reservations.service.ts:335-343`）。也就是说时段维度**已经存在**，`Seat.status` 这条写入路径是重复的，而且会覆盖掉前者的正确结果。

**问题三：写入来源不可追溯。** 任务书要求「M1 的座位状态必须记录写入来源（M1 自身预约／M2 审批占用／M3 报修下架），供追溯与验收」。现状把来源拆在三个地方：`seat_status_logs`（实际只有 M3 在用）、`reservations`、`room_booking_requests`。没有任何一个地方能回答「*这个座位在这个时段*为什么不可约，是谁写的」。

**问题四：跨模块直连。** M1 目前直接注入 `RoomBookingRequest` 仓库读取 M2 的数据，与 `AGENTS.md` 第 3 条「模块间不得直接访问数据库」冲突。

## 2. 决策驱动因素

1. 时间维度必须是一等公民，而不是靠定时任务事后修补。
2. 写入来源可追溯、可验收 —— 任务书硬性要求，也是演示时最容易被追问的点。
3. 模块边界清晰：M1 不得读 M2 的表，M2 不得改 M1 的座位语义。
4. 变更成本可控：3 人小组、课业并行，方案不能需要重写全部业务表。

## 3. 候选方案

### 方案 A：维持 `Seat.status`，补充「到期自动释放」任务

在活动结束后由定时任务把座位改回 `available`。

- 优点：几乎不改代码。
- 缺点：同一教室一天内多个时段仍然无法表达（上午被占、下午空闲会互相覆盖）；释放窗口内（活动结束到任务执行）依旧误判；两套判据并存的问题没有解决；来源仍不可追溯。
- 结论：**放弃**。它只是把 bug 从「永久」缩成「一段时间」，没有解决建模错误。

### 方案 B：`Seat.status` 只表达物理状态，时段占用由统一的占用记录表达（推荐）

- `Seat.status ∈ {available, maintenance, retired}` —— 只描述座位**自身**的物理/管理状态，与时间无关。
- 新增 `occupancies` 表，一行 = 「某个座位或某个空间，在某个时段被占用」，带 `source` 与 `refType/refId`。
- 可用性 = 物理可用 ∧ 无座位级重叠 ∧ 无所属空间的教室级重叠。
- 写入全部经过公共层的 `OccupancyService`，M1/M2/M3 不直接写表。

### 方案 C：不新增表，M1 通过 M2 的只读接口实时查询

M2 暴露「查询某空间某日期的已批准时段」接口，M1 调用。

- 优点：不动数据模型，M2 的数据仍归 M2。
- 缺点：M1 每次搜索座位都要跨模块调用，N 个教室 = N 次调用或一次批量调用；M3 将来若要表达「按时段维修」还得再加一套；写入来源仍然分散，任务书的追溯要求没有单一答案。
- 结论：作为**降级方案**保留。如果组内认为新增公共层能力成本过高，可以退回到这个方案，它至少能修掉问题一和问题二。

## 4. 决策

采用**方案 B**。

### 4.1 数据模型

```sql
occupancies (
  id           PK
  scope        varchar  NOT NULL   -- 'seat' | 'space'
  spaceId      int      NOT NULL
  seatId       int      NULL       -- scope='seat' 时必填
  date         varchar  NOT NULL   -- 'YYYY-MM-DD'
  startHour    int      NOT NULL   -- 整点，含
  endHour      int      NOT NULL   -- 整点，不含
  source       varchar  NOT NULL   -- 'M1' | 'M2' | 'M3' | 'SYSTEM'
  refType      varchar  NOT NULL   -- 'reservation' | 'room_request' | 'work_order'
  refId        int      NOT NULL
  operatorId   int      NULL
  reason       varchar  NOT NULL DEFAULT ''
  releasedAt   datetime NULL       -- 释放时刻；NULL 表示仍然有效
  createdAt    datetime NOT NULL
)
```

索引：`(spaceId, date)`、`(seatId, date)`、`(refType, refId)`。

`releasedAt` 而不是物理删除，是为了保留「谁在什么时候占了、又为什么放开」的完整轨迹，这本身就是任务书要的验收材料。

### 4.2 谁写什么

| 场景 | scope | source | refType | 动作 |
|------|-------|--------|---------|------|
| M1 预约成功 | seat | M1 | reservation | 插入 |
| M1 取消 / 违约释放 | seat | M1 | reservation | 置 `releasedAt` |
| M2 最终审批通过 | space | M2 | room_request | 插入**一条**（不是每个座位一条） |
| M2 驳回 / 撤销 / 超时 | space | M2 | room_request | 置 `releasedAt` |
| M3 报修 | — | — | — | **不写 occupancy**：维修是座位的物理状态，写 `Seat.status='maintenance'` |

最后一行是本次决策的关键区分：**「维修中」和「被预约」是两种不同的不可用**。前者是座位坏了（与时间无关，恢复要靠验收），后者是这个时段被人占了（到期自然失效）。混在一个 `status` 字段里，正是现状出问题的根源。

### 4.3 读路径

`OccupancyService` 对外提供：

```ts
isSeatAvailable(seatId, date, startHour, endHour): Promise<boolean>
explain(seatId, date, startHour, endHour):
  Promise<{ source: 'M1'|'M2'|'M3'; refType: string; refId: number } | null>
batchBySpaces(spaceIds, date, startHour, endHour): Promise<Map<spaceId, BlockInfo>>
```

`explain` 是「可追溯」要求的落点：前端在座位卡片上直接显示「该时段不可预约：整教室审批占用（RB-20261024-001）」，演示时可以一眼验证来源。

### 4.4 与业务表的关系

`Reservation` 和 `RoomBookingRequest` **保留**，它们是业务记录（谁申请的、审批链、用途、金额/理由），`occupancies` 是「占用事实」的投影。两者在**同一个数据库事务**内写入，避免出现「有申请单但没占上」的半成品状态。

占用记录是可用性的**唯一判据**；业务记录用于展示、审计与统计。

## 5. 影响

- **迁移**：新增 `0002-occupancies` 迁移，空库可一次性重放。
- **M1**：`searchSeats` / `bookSeat` / `cancel` 改用 `OccupancyService`；新增可用性原因字段；移除对 `RoomBookingRequest` 仓库的直接依赖（解决问题四）。
- **M2**：删除 `occupyByRoom` / `releaseRoom` 对 `Seat.status` 的写入，改为写/释放 `occupancies`。`SeatStateService` 收缩为只处理物理状态（维修上下架）。
- **M3**：不变。
- **前端**：座位不可约时展示原因；审批通过后不再出现「整间教室永久消失」。
- **测试**：现有 `m2-rooms.spec.ts` 中断言 `occupied_by_room` 的用例必须改写 —— 它固化的是错误行为。

## 6. 遗留问题（不在本 ADR 解决）

1. M3 的维修是否需要时段化（例如只修上午）？v1 不做，物理状态足够。
2. `occupancies` 的历史保留策略：默认保留，作为运营统计与审计依据；数据量在课程规模下可忽略。
3. 座位「锁定/暂离」等状态不在范围内。
