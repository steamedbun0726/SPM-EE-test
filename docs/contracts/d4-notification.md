# D4 通知服务契约

- 子域 owner：**M3**
- 版本：v1.0（2026-11-05）
- 实现：`backend/src/shared/notifications/notifications.service.ts`
- 依赖：仅 `Notification` 实体与仓储；不依赖任何业务模块

## 1. 能力边界

已实现**站内通知**（落库、查询、已读、未读计数）。邮件与微信服务号推送**未实现**，`NotificationType` 与 `send()` 签名已为其预留渠道抽象，但当前没有任何 provider 实现，也没有重试、模板、限流。

消费方不得假设通知一定送达终端用户——站内未读列表是唯一可靠投递证据。

## 2. 类型

```ts
type NotificationType = 'reminder' | 'no_show' | 'approval' | 'workorder' | 'system';

interface Notification {
  id: number;
  userId: number;
  type: NotificationType;
  title: string;
  content: string;   // 默认 ''
  isRead: boolean;   // 默认 false
  createdAt: Date;
}
```

`type` 用于前端分组与筛选，新增值必须同步前端字典；未登记的字符串会被数据库接受（列类型为 varchar，无 CHECK 约束）。

## 3. 方法签名

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `send` | `(userId: number, type: NotificationType, title: string, content: string)` | `Promise<Notification>` | 单条。返回含 `id` 的实体 |
| `sendBatch` | `(userIds: number[], type: NotificationType, title: string, content: string)` | `Promise<number>` | 逐用户各生成一条**内容相同**的通知，返回条数 = `userIds.length` |
| `listForUser` | `(userId: number, unreadOnly = false)` | `Promise<Notification[]>` | 按 `id DESC`，**最多 100 条**，无分页游标 |
| `markRead` | `(id: number, userId: number)` | `Promise<{ ok: true }>` | 按 `(id, userId)` 双条件更新 |
| `markAllRead` | `(userId: number)` | `Promise<{ ok: true }>` | 该用户全部置已读 |
| `unreadCount` | `(userId: number)` | `Promise<number>` | `countBy({ userId, isRead: false })` |

## 4. 失败语义与幂等性

| 场景 | 行为 |
|------|------|
| `userId` 不存在 | **静默成功**。`notifications.userId` 无外键约束，不校验用户存在，脏数据会落库 |
| `title` / `content` 为空 | 静默成功。`title` 为 `NOT NULL` 但无最小值校验，空串可入库 |
| `sendBatch([])` | 返回 `0`，不抛错 |
| 同一事件重复调用 `send` | **不幂等**，产生重复通知。去重责任在调用方 |
| `markRead` 传入他人通知的 id | 不抛错、`affected = 0`，仍返回 `{ ok: true }`。这是刻意设计：不泄露他人通知是否存在 |
| 数据库写入失败 | 向上抛错。**调用方必须自行决定是否吞掉**，见 §5 |

## 5. 事务边界（重要）

所有方法**不接受 `EntityManager` 参数**，通知写入使用独立连接。

后果：调用方在业务事务内发通知时，若事务随后回滚，通知仍然存在（幽灵通知）；反之通知写失败会让已提交的业务操作表现为接口 500。

现有调用方均采用「业务写入成功后再发通知」的顺序，不放在同一事务内。**新的消费方必须沿用这一顺序**，不要试图把 `send` 塞进 `dataSource.transaction` 里。

## 6. HTTP 面

全局守卫已注册（`JwtAuthGuard` + `PermissionsGuard`），以下接口均需登录，不额外要求权限码。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/notifications?unreadOnly=true` | 当前用户通知，最多 100 条 |
| GET | `/api/notifications/unread-count` | 当前用户未读数 |
| POST | `/api/notifications/:id/read` | 单条已读 |
| POST | `/api/notifications/read-all` | 全部已读 |

## 7. 消费方登记

| 消费方 | 位置 | 方法 | 场景 |
|--------|------|------|------|
| M2 | `m2-rooms/room-requests.service.ts:171` | `send` (`approval`) | 审批通过通知申请人 |
| M2 | `m2-rooms/room-requests.service.ts:214` | `send` (`approval`) | 审批驳回通知申请人 |
| M2 | `m2-rooms/room-requests.service.ts:297` | `send` (`approval`) | 超时撤销通知申请人 |
| M3 | `m3-maintenance/work-orders.service.ts` 多处 | `send` / `sendBatch` (`workorder`) | 派单、开工、挂起确认、完工、验收、升级、合并 |
| M1 | `m1-seats`（`m1/dev` 分支） | `send` (`reminder` / `no_show`) | 预约提醒、违约通知；外部推送失败时降级到站内 |

## 8. 未实现项

| 项 | 影响 | 状态 |
|----|------|------|
| 邮件 / 微信服务号 provider | 任务书要求的「邮件、微信服务号等渠道」只有站内实现 | 未做 |
| 投递重试与失败告警 | 外部渠道接入后必须有，否则静默丢失 | 未做 |
| 通知模板与变量校验 | 当前内容由调用方拼字符串，措辞不一致 | 未做 |
| 分页 | `listForUser` 硬上限 100 条，历史通知读不到 | 未做 |
| 批量上限 | `sendBatch` 无分片，上千用户会撞 SQL 变量上限 | 未做 |

## 9. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-11-05 | 首版。按 ADR-0004 §4.2 时间盒交付接口定义 + 契约测试（实现为既有代码） |
