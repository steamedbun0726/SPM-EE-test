# I 跨模块集成

> 描述模块边界上的契约，验证方式一律要求「故意破坏后测试变红」，不接受仅接口跑通。
> 本节口径已于 2026-11-05 按 ADR-0002（可用性模型）与 ADR-0004（公共层归属）更新，此前的「M2 审批通过 → M1 座位状态写入」表述已作废。
> 状态图例：🟢 已实现（雏形）｜🟡 部分实现｜🔴 未实现

| ID | 需求 | 状态 | 实现位置 | 验证方式 |
|----|------|------|----------|----------|
| I-01 | M3 维修中（整空间）→ M1 该空间座位下架；验收/取消后恢复 | 🟢 | `SeatStateService.setSpaceMaintenance` | `test/m3-work-order-collab.spec.ts` + 故障注入（破坏恢复逻辑观察变红） |
| I-02 | M2 审批通过 → 该教室该时段写入**空间级占用**；驳回/撤销/超时释放；全程不改 `Seat.status` | 🟢 | `OccupancyService` | M2 单元测试 + 故障注入（见 `docs/m2/质量验证.md`） |
| I-03 | 座位不可预约时可追溯写入来源（M1/M2/M3），返回来源类型与单号 | 🟢 | `OccupancyService.explain` / `SeatStatusLog` | M2 单元测试 + `test/m3-work-order-collab.spec.ts` |
| I-04 | M2 提交申请前检查座位级占用，避免与个人预约冲突 | 🟡 | `OccupancyService.countSeatBlocks` | 逻辑已就绪；**依赖 M1 将预约写入 `occupancies`**（M1 侧迁移待做） |

I-01 只覆盖「整空间下架」；单座位粒度的下架与恢复见 [M3-07 / M3-19](./m3.md)，两者的载体都是 `SeatStateService`，因此任何绕过它直改 `Seat.status` 的写入都会绕过 I-03 的来源追溯。

## 本节未完成项

- **I-04 阻塞在 M1**：M1 尚未把个人预约写入 `occupancies`，因此 M2 的座位级冲突预检目前恒为 0——「恒为 0」意味着该预检在真实数据下从未生效过，测试通过不能作为已实现证据。
- **I-02 / I-03 未合入主干**：实现位于 PR #1（`feat/m2-adr-baseline`），本地 M3 分支与 main 均无 `occupancy.service.ts`。
- **`occupied_by_room` 残留归属未定**：ADR-0002 要求从 `Seat.status` 枚举中删除该值，但 M3 侧仍有 `shared/spaces/seat-state.service.ts` 两处、`shared/spaces/spaces.service.ts` 一处引用，且 `test/m2-rooms.spec.ts` 直接断言它。这三处属 D 公共层，应由 D 层 owner 统一清理，待 ADR-0004 分工确认后指派。
