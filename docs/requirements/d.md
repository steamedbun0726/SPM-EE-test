# D 公共层

> 覆盖 ADR-0004 划分的 D1~D5 五个子域，子域与条目的对应关系见 [README](./README.md#adr-0004-子域与条目映射)。
> 状态图例：🟢 已实现（雏形）｜🟡 部分实现｜🔴 未实现

| ID | 需求 | 状态 | 实现位置 | 验证方式 |
|----|------|------|----------|----------|
| D-01 | 基于 RBAC 的用户身份与权限模型（用户/角色/权限多对多） | 🟢 | `shared/rbac` | 单元测试 + 登录鉴权集成测试 |
| D-02 | 系统管理员可管理所有系统配置、角色、权限 | 🟢 | `shared/rbac` + 前端 `views/admin` | 接口测试 + UI 演示 |
| D-03 | 空间主数据：自习室登记/注销/开放时间维护 | 🟢 | `shared/spaces` | 接口测试 |
| D-04 | 座位主数据：座位登记/注销/可用性维护 | 🟢 | `shared/spaces` | 接口测试 |
| D-05 | 通知服务（邮件/站内推送的抽象，雏形以站内通知实现） | 🟢 | `shared/notifications` + `docs/contracts/d4-notification.md` | `test/d4-d5-contract.spec.ts`（6 条）+ 触发预约提醒后断言通知记录 |
| D-06 | 操作审计：记录关键操作的操作者、动作、资源、时间 | 🟢 | `shared/audit` + `docs/contracts/d5-audit.md` | `test/d4-d5-contract.spec.ts`（5 条）+ 审计拦截器 + 查询接口 |
| D-07 | 角色示例：学生、教师、教室管理员、运营管理员、系统管理员、物业维修员、审批员 | 🟢 | 种子数据 | 登录各角色验证权限 |
| D-08 | 空间时段占用（`occupancies`）：按空间+时段记录占用，座位级预约与整教室审批共用一套可用性解释 | 🟡 | `shared/spaces/occupancy.service.ts`（PR #1，未合入 main） | M2 单元测试 + 故障注入（`test/m2-rooms.spec.ts`） |

D-03 / D-04 原为同一行，按「空间」与「座位」两级实体拆分；D-08 是 ADR-0002 引入的可用性模型落地，此前需求基线中没有对应条目，MR 评审时无法回答「`OccupancyService` 对应哪条需求」。

## 本节未完成项

- **D-05 四项未落地**：发送失败重试、通知模板、推送记录分页、单次批量上限。当前 `sendMany` 无上限、无重试，失败即抛出。详见 `docs/contracts/d4-notification.md` §未实现项。
- **D-06 两项缺陷**（已在契约中如实记录，未修）：`AuditInterceptor` 用 `tap()`，只记录成功返回，越权尝试/校验失败/冲突拒绝全部无痕；`detail` 存请求体原文（截断 500 字符）未脱敏，`POST /api/users` 的密码会明文进 `audit_logs`。
- **D-08 未合入主干**：实现在 PR #1（`feat/m2-adr-baseline`），本地分支与 main 均无此文件；ADR-0002 状态仍为「提议」，且与 `docs/backend-contracts.md` 中 `Seat.status = occupied_by_room` 的约定冲突，需三人确认。
