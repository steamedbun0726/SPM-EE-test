# D5 操作审计契约

- 子域 owner：**M3**
- 版本：v1.0（2026-11-05）
- 实现：`backend/src/shared/audit/audit.service.ts`、`audit.interceptor.ts`、`audit.controller.ts`
- 依赖：仅 `AuditLog` 实体与仓储

## 1. 能力边界

D5 记录**写操作的 HTTP 级痕迹**：谁、什么时候、对哪个资源、调了什么方法、带了什么请求体。它不记录字段级前后值，也不承担业务语义审计。

业务语义审计（例如「工单从 `in_progress` 变为 `completed`，操作人 X，说明 Y」）由各模块自己的事件表承担：M3 用 `work_order_events`，M1/M2 目前没有对应表。**两者不互相替代**，D5 回答「有没有人调过这个接口」，事件表回答「业务上发生了什么」。

## 2. 类型

```ts
interface AuditInput {
  userId: number | null;   // null = 未认证或系统行为
  username: string;        // 无认证时写 'anonymous'
  action: string;          // '${METHOD} ${path}'，如 'POST /api/work-orders/12/dispatch'
  resourceType: string;    // 路径第 1 段，如 'work-orders'
  resourceId: string;      // 路径第 2 段，如 '12'
  detail: string;          // 请求体 JSON，最长 500 字符
  ip: string;
}

interface AuditLog extends AuditInput {
  id: number;
  createdAt: Date;
}
```

`detail` 存的是**请求体原文**，可能包含密码、手机号等敏感字段。当前没有任何脱敏。调用方若在请求体里传凭据，会被原样落库——登录接口已在拦截器白名单外，但 `POST /api/users` 这类接口的 `password` 字段会进审计表。

## 3. 方法签名

| 方法 | 签名 | 返回 | 说明 |
|------|------|------|------|
| `record` | `(input: AuditInput)` | `Promise<AuditLog>` | 写一条。无去重、无校验 |
| `findAll` | `({ keyword?, page?, pageSize? })` | `Promise<{ items: AuditLog[]; total: number }>` | `keyword` 对 `username` / `action` / `detail` 三列做 `%k%` 模糊匹配；按 `id DESC`；默认 `page=1`、`pageSize=20` |

## 4. 失败语义与幂等性

| 场景 | 行为 |
|------|------|
| `record` 写入失败 | 向上抛错。但**拦截器会吞掉**（`.catch(() => undefined)`），主流程不受影响 |
| 同一请求重复调用 `record` | 不幂等，产生多条 |
| `findAll` 的 `keyword` 含 `%` 或 `_` | 未做 LIKE 转义，`%` 会被当通配符，返回超大结果集（对比：M3 `listAll` 的 `escapeLike` 已处理该问题） |
| `findAll` 的 `page` / `pageSize` 非法值 | controller 直接 `Number()`，`NaN` 会导致 `skip(NaN)` 报错 |

## 5. 全局拦截器语义

`AuditInterceptor` 以 `APP_INTERCEPTOR` 注册，作用于全部路由。

| 项 | 规则 |
|----|------|
| 触发范围 | `POST` / `PUT` / `PATCH` / `DELETE`；GET 不记 |
| 触发时机 | `tap()` —— 仅在处理器**正常返回**后记录 |
| 失败请求 | **不记录**。业务抛 4xx/5xx 时审计表无痕，这是当前最大的逻辑缺口 |
| `action` | `${method} ${originalUrl 去掉 query}` |
| `resourceType` / `resourceId` | `path.split('/')` 的第 2、3 段（全局前缀 `api` 占第 1 段） |
| `detail` | `JSON.stringify(body).slice(0, 500)` |
| 未认证请求 | `userId = null`、`username = 'anonymous'` |

路径不含 `api` 前缀时（例如内部调用或测试直调 controller），`resourceType` 会取到错误段。依赖该字段做统计前必须确认请求经过全局前缀。

## 6. HTTP 面

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/audit?keyword=&page=&pageSize=` | `audit.view` | 分页查询审计日志 |

`audit.view` 当前授予 `room_admin` 与 `ops` 两个角色（见 `seed-data.ts`）。

## 7. 消费方登记

| 消费方 | 方式 | 场景 |
|--------|------|------|
| 全局 | `AuditInterceptor` | 所有写接口自动记录 |
| — | — | **暂无业务模块显式调用 `record`** |

业务侧零显式调用是已知状态：意味着「谁审批了哪张单」这类关键动作只能靠 HTTP 路径 + 请求体反推，而不是一条结构化记录。

## 8. 未实现项

| 项 | 影响 | 状态 |
|----|------|------|
| 失败操作审计 | 越权尝试、校验失败、冲突拒绝全部无痕，恰恰是审计最该关注的 | 未做 |
| 敏感字段脱敏 | `password` 等明文入库 | 未做 |
| 业务侧结构化调用 | 关键动作靠路径反推，`resourceId` 依赖 URL 结构 | 未做 |
| LIKE 转义 | `keyword` 含 `%` 时结果失控 | 未做 |
| 保留策略 | 无清理、无归档，表会无限增长 | 未做 |
| 按 `resourceId` 精确检索 | 只能模糊匹配 | 未做 |

## 9. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-11-05 | 首版。按 ADR-0004 §4.2 时间盒交付接口定义 + 契约测试（实现为既有代码） |
