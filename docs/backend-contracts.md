# 后端模块实现契约（backend-contracts）

> 本文档供 M1/M2/M3 模块实现时遵循。动手前必须阅读：`AGENTS.md`、`docs/requirements.md`、本契约，以及 `backend/src/database/entities/` 下所有实体文件。

## 通用约定

- 项目：`backend/`，NestJS + TypeORM，全局前缀 `api`，全局启用 `JwtAuthGuard`（公开接口加 `@Public()`）。
- 权限控制：控制器方法上使用 `@Permissions('xxx')`（RBAC）。权限码见种子数据（`backend/src/database/seeds/seed-data.ts`）。
- 当前用户：参数 `@CurrentUser() user: JwtUser`（`JwtUser` 含 `userId/username/name/roles/permissions/department`）。
- 业务异常：抛 `HttpException`（如 `BadRequestException`/`NotFoundException`/`ConflictException`）。
- 日期时段：预约/审批/工单均按 `date: 'YYYY-MM-DD'` + `startHour/endHour`（整点小时，0–23，endHour 不含）表示。
- 业务参数：通过 `SystemConfigService.getInt(key, default)` 读取（如 `BOOKING_MAX_HOURS`）。
- 通知：通过 `NotificationsService.send(userId, type, title, content)` 发送站内通知。
- 座位状态变更：**必须**经 `SeatStateService`（跨模块集成核心），禁止直接改 `Seat.status`。

## 已提供的共享服务（SharedModule @Global 导出）

| Service | 关键方法 |
|---------|----------|
| `SpacesService` | `findAll`, `findById(id)`, `findByCode`, `findSeatById(seatId)`（含 space 关系）, `listSeats(spaceId)` |
| `SeatStateService` | `setMaintenance(spaceId, workOrderId, operatorId, reason)`, `restoreAfterMaintenance(...)`, `occupyByRoom(spaceId, requestId, seatIds, operatorId, reason)`, `releaseRoom(spaceId, requestId, seatIds, operatorId, reason)`, `history(seatId, limit?)` |
| `NotificationsService` | `send(userId, type, title, content)` |
| `SystemConfigService` | `getInt(key, default)`, `get(key, default)` |
| `AuditService` | `record(input)`（也可不直接用，全局拦截器已自动审计写接口） |

## 座位状态字段（Seat）

- `status`: `available` | `maintenance`（M3 维修中下架）| `occupied_by_room`（M2 审批占用）
- `statusSource`: 最近一次变更来源 `M1|M2|M3|SYSTEM`
- 个人预约（M1）**不改变** Seat.status，通过 `Reservation` 表表达占用；冲突检测见下。

## M1 自习座位预约（modules/m1-seats）

依赖实体：`Reservation`, `Violation`, `Seat`, `Space`。
Service：`ReservationsService`（提供公开方法，供 Agent 调用）。

### 公开方法（Agent 集成点）

```ts
searchSeats(query: { spaceId?; spaceName?; date; startHour; endHour; hasSocket? }): Promise<SearchSeatItem[]>
// 返回可预约座位：Seat.isActive && status=available，且该座位在该日期时段无冲突
// 冲突判定（三条都要查）：
//   a) Reservation: seatId+date+时段重叠+status in ('booked','checked_in')
//   b) RoomBookingRequest: spaceId+date+时段重叠+status='approved'  ← 需注入 RoomBookingRequest 仓库
//   c) 院系自习室：Space.ownerDept 非空时，仅当 user.department===ownerDept 可见（M1-05）
bookSeat(userId, { seatId; date; startHour; endHour }): Promise<Reservation>
// 校验：整点(默认约束由前端保证)、endHour-startHour<=BOOKING_MAX_HOURS(默认4)、
//       座位存在且可约、无冲突、空间开放时间范围；成功创建 status='booked' 记录并返回
checkIn(userId, reservationId, code): Promise<Reservation>
// 校验：预约属于该用户、status='booked'、code 与预约座位所在空间动态码一致；置 status='checked_in', checkInAt=now
listMyReservations(userId, { status? }): Promise<Reservation[]>
history(userId, { page? }): Promise<{items,total}>   // 历史预定（含 completed/no_show/cancelled）
cancel(userId, reservationId): Promise<Reservation>  // 仅未开始的 booked 可取消
rebook(userId, reservationId): Promise<Reservation>  // 历史复用：取原座位/时段重新预约
getDynamicCode(spaceId, date): { code: string }      // 与教室关联的动态签到码（基于 spaceId+date 确定性生成，如 'A'+spaceId+日期哈希）
stats(): Promise<{ spaceId; code; name; bookingCount; noShowCount }[]>  // 运营统计（M1-11）
```

### Controller 路由（全部需要 JWT；公开接口才加 @Public）

```
GET    /api/m1/seats/search          → searchSeats（权限 seat.search；学生可见可约座位）
POST   /api/m1/reservations          → bookSeat（权限 seat.book）
POST   /api/m1/reservations/:id/check-in  → checkIn（权限 seat.signin；body:{code}）
GET    /api/m1/reservations/mine     → listMyReservations
GET    /api/m1/history               → history
POST   /api/m1/reservations/:id/cancel → cancel
POST   /api/m1/reservations/:id/rebook → rebook
GET    /api/m1/spaces/:spaceId/dynamic-code → getDynamicCode
GET    /api/m1/stats                 → stats（权限 stats.view）
```

注意：M1 搜索/预约的冲突检测需要 `RoomBookingRequest` 仓库（跨 M2 数据），在 M1 模块注入 `@InjectRepository(RoomBookingRequest)`（TypeORM forFeature 加入该实体）——这是 M2→M1 集成的读取侧。

## M2 整教室预约与审批（modules/m2-rooms）

依赖实体：`RoomBookingRequest`, `ApprovalRecord`。
Service：`RoomRequestsService`（公开方法）。

### 公开方法

```ts
apply(userId, { spaceId; date; startHour; endHour; purpose }): Promise<RoomBookingRequest>
// 校验：空间存在；时段合法；该空间该时段无已 approved 的冲突申请；生成 requestCode（RB-YYYYMMDD-序号）、timeoutAt=now+ROOM_APPROVAL_TIMEOUT_HOURS
approve(requestId, approverUserId, { comment? }): Promise<RoomBookingRequest>
// 校验：有 room.approve 权限（Controller 层）；request.status='pending'；
// 写 ApprovalRecord(level=currentLevel)；若 currentLevel<maxLevel → currentLevel+1 仍 pending；
// 否则 → approved，调用 SeatStateService.occupyByRoom(spaceId, requestId, 该室可用座位ids, approverUserId, '整教室审批通过')
reject(requestId, approverUserId, { comment }): Promise<RoomBookingRequest>
// → rejected，记 ApprovalRecord；若曾占用则 SeatStateService.releaseRoom 回滚
cancel(userId, requestId): Promise<RoomBookingRequest>  // 申请人撤销（pending 时）；若曾占用回滚
listMine(userId, { status? }): Promise<RoomBookingRequest[]>
listPending(): Promise<RoomBookingRequest[]>            // 审批队列（权限 room.approve）
getStatus(userId, requestId): Promise<RoomBookingRequest>  // 查申请状态（含审批记录 approvals）
getApprovals(requestId): Promise<ApprovalRecord[]>
expireOverdue(): Promise<number>  // 定时任务调用：pending 且 timeoutAt<now → expired，回滚占用
```

### Controller 路由

```
POST /api/m2/requests        → apply（权限 room.apply）
POST /api/m2/requests/:id/approve → approve（权限 room.approve）
POST /api/m2/requests/:id/reject  → reject（权限 room.approve）
POST /api/m2/requests/:id/cancel  → cancel（本人）
GET  /api/m2/requests/mine        → listMine
GET  /api/m2/requests/pending     → listPending（权限 room.approve）
GET  /api/m2/requests/:id         → getStatus（本人或审批人）
GET  /api/m2/requests/:id/approvals → getApprovals
```

## M3 物业报修工单（modules/m3-maintenance）

> **v1.1 更新（2026-10-27）**：一期 + 二期共 19 条需求已落地，本节的公开方法清单已过期。
> 权威清单见 `backend/src/modules/m3-maintenance/work-orders.service.ts` 与
> `docs/m3/02-需求规格.md` 附录 A。以下为**新增的跨模块契约**，其他组需要知道的部分：
>
> **M3 → M1（新增依赖）**：`M3MaintenanceModule` 现 `imports: [M1SeatsModule]`，用于在座位下架后
> 处置已有预约。依赖方向单向 M3→M1，无循环。
>
> ```ts
> // M1 ReservationsService 新增公开方法（M3 调用）
> cancelForSeatsUnderMaintenance(seatIds: number[]): Promise<MaintenanceCancelledReservation[]>
> // 未来时段的 booked → cancelled（不写 violations，不计违约）
> // 已开场 / 已签到的 → 返回 ongoing=true 且不改状态，交人工协调
> ```
>
> **D2 座位主数据（shared/spaces/seat-state.service.ts）新增 4 个座位粒度方法**，
> 供 M3 部分下架使用；既有方法签名未改动，兼容 M1/M2 现有调用：
>
> ```ts
> setSeatsMaintenance(seatIds, workOrderId, operatorId, reason): Promise<number>
> setSeatMaintenance(seatId, workOrderId, operatorId, reason): Promise<boolean>
> restoreSeatsAfterMaintenance(seatIds, workOrderId, operatorId, reason): Promise<number>
> restoreSeatAfterMaintenance(seatId, workOrderId, operatorId, reason): Promise<boolean>
> ```
>
> **D1 用户（shared/rbac/users.service.ts）新增 1 个反查方法**，供 M3 派单与告警使用：
>
> ```ts
> findByPermission(permissionCode: string): Promise<UserWithRoles[]>
> ```
>
> **M1 既有逻辑的一处修正**：`ReservationsService.bookSeat` 现在会在必要时**复用历史行**
> （同 seatId+date+startHour 的 cancelled/no_show/completed 记录）而不是直接 insert，
> 以规避 `IDX_reservations_seat_slot` 唯一索引导致的「取消后再也约不上 → 500」。
> 与 M1 自身 `rebook` 的策略一致。需 M1 组复核。

### 一期基线契约（历史记录，部分已被 v1.1 覆盖）

依赖实体：`WorkOrder`。
Service：`WorkOrdersService`（公开方法）。

### 公开方法

```ts
report(userId, { title; description?; category?; priority?; targetType; targetId?; spaceId? }): Promise<WorkOrder>
// 生成 workOrderNo（WO-YYYYMMDD-序号），status='reported'，slaDeadline=now+WORKORDER_SLA_HOURS
// 若 targetType='space' 且 spaceId 存在 → 立即调用 SeatStateService.setMaintenance(spaceId, workOrderId, userId, '报修维修中')
dispatch(workOrderId, assigneeId, dispatcherUserId): Promise<WorkOrder>  // 权限 workorder.dispatch → status='dispatched', dispatchedAt
startWork(workOrderId, assigneeId): Promise<WorkOrder>  // 维修员接单 → status='in_progress', inProgressAt
complete(workOrderId, assigneeId): Promise<WorkOrder>   // → status='completed', completedAt
accept(workOrderId, reporterId, { rating?; comment? }): Promise<WorkOrder>  // 验收 → status='accepted', acceptedAt, rating
// 若该工单曾下架空间座位（spaceId 存在）→ SeatStateService.restoreAfterMaintenance(spaceId, workOrderId, reporterId, '工单验收通过')
cancel(workOrderId, userId, { reason }): Promise<WorkOrder>  // 上报人取消（reported/dispatched 时）；若曾下架座位 → 恢复
listMine(userId, { status? }): Promise<WorkOrder[]>
listPending(): Promise<WorkOrder[]>      // 待派单（权限 workorder.dispatch）
listAssignments(assigneeId): Promise<WorkOrder[]>  // 我接的工单
getStatus(userId, workOrderId): Promise<WorkOrder>  // 查工单状态
escalateOverdue(): Promise<number>  // 定时任务：in_progress 且 slaDeadline<now → escalateLevel+1，重设 slaDeadline（now+小时），记录到 title/description 或通知
```

### Controller 路由

```
POST /api/m3/work-orders          → report（权限 workorder.report）
POST /api/m3/work-orders/:id/dispatch  → dispatch（权限 workorder.dispatch；body:{assigneeId}）
POST /api/m3/work-orders/:id/start     → startWork（维修员本人）
POST /api/m3/work-orders/:id/complete  → complete（维修员本人）
POST /api/m3/work-orders/:id/accept    → accept（上报人；body:{rating?,comment?}）
POST /api/m3/work-orders/:id/cancel    → cancel（本人；body:{reason}）
GET  /api/m3/work-orders/mine          → listMine
GET  /api/m3/work-orders/pending       → listPending（权限 workorder.dispatch）
GET  /api/m3/work-orders/assignments   → listAssignments（维修员）
GET  /api/m3/work-orders/:id           → getStatus（本人/维修员/管理员）
```

### v1.1 新增路由

```
POST  /api/m3/work-orders/:id/reassign        → reassign（权限 workorder.dispatch）
POST  /api/m3/work-orders/:id/comments        → addComment（上报人/维修员/派单员）
PATCH /api/m3/work-orders/:id/eta             → updateEta（参与人）
PATCH /api/m3/work-orders/:id/photos          → updatePhotos（参与人，≤3 张）
POST  /api/m3/work-orders/:id/appeal          → appeal（权限 workorder.handle，仅指派维修员）
POST  /api/m3/work-orders/:id/appeal/resolve  → resolveAppeal（权限 workorder.manage）
POST  /api/m3/work-orders/:id/revisit         → handleRevisit（权限 workorder.manage）
GET   /api/m3/work-orders/meta                → meta（字典与限制，无需权限）
GET   /api/m3/work-orders/escalated           → listEscalated（权限 workorder.dispatch）
GET   /api/m3/work-orders/revisits            → listRevisits（权限 workorder.manage）
GET   /api/m3/work-orders/degraded            → listDegraded（权限 workorder.dispatch）
GET   /api/m3/work-orders/technicians         → technicianWorkload（权限 workorder.stats）
GET   /api/m3/work-orders/:id/events          → listEvents（访问控制同详情）
```

所有返回单个工单的接口统一返回 **WorkOrderView**：实体字段 + `seatIdList`、`photoUrlList`（已解析的数组）
+ `categoryLabel`、`priorityLabel`、`statusLabel` + `slaRemainMs`、`slaUsedRatio`。

## 模块文件组织

```
src/modules/m1-seats/{m1-seats.module.ts, reservations.service.ts, reservations.controller.ts}
src/modules/m2-rooms/{m2-rooms.module.ts, room-requests.service.ts, room-requests.controller.ts}
src/modules/m3-maintenance/{m3-maintenance.module.ts, work-orders.service.ts, work-orders.controller.ts}
```

每个 module 内 `TypeOrmModule.forFeature([...])` 引入自己用到的实体，再 `imports: []`（SharedModule 是 Global 无需 import）。Controller 在 module 中注册。module 需 `exports` Service 供调度器/测试使用。

## 编号生成

`RB-YYYYMMDD-0001` / `WO-YYYYMMDD-0001`：可用当天最大序号+1（查询 count 或 max id），并用 `@Column({unique:true})` 兜底（冲突时重试一次）。

## 测试要求

- `backend/test/m1-seats.spec.ts`：搜索冲突、超时预约拒绝、签到码校验、违约自动取消逻辑
- `backend/test/m2-rooms.spec.ts`：多级审批流转、通过后占用、驳回回滚、超时撤销
- `backend/test/m3-maintenance.spec.ts`：下架/恢复、派单流转、超时升级
- 测试用内存 sqljs 连接（见 `backend/test/test-utils.ts`），直接调用 Service 方法（不依赖 HTTP），断言真实状态变化。
