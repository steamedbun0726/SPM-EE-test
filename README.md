# 校园资源服务平台（CampusHub）— 课程实践项目（PJ）雏形

依据《软件过程管理与工程伦理 · 课程实践项目（PJ）任务书》（复旦大学计算与智能创新学院 2026–2027 秋季学期）搭建的系统雏形，供项目组 3 个模块组在此基础之上继续开发、优化并最终交付。

## 系统定位

以**自习座位预约（M1）**为核心，向**整教室预约与审批（M2）**、**物业报修工单（M3）**延伸，公共层（D）提供 RBAC 身份权限、空间/座位主数据、通知服务与操作审计。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | NestJS + TypeScript + TypeORM |
| 数据库 | PostgreSQL（生产）/ SQLite（开发默认，`DB_TYPE` 一行切换） |
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router |
| 认证 | JWT + RBAC |

## 目录结构

```
SPMEE/
├── AGENTS.md          # 项目级 AI 协作规则（机器可读）
├── docs/              # 需求基线、决策记录（ADR）、CI 说明
├── backend/           # NestJS 后端（D 公共层 + M1/M2/M3 模块）
├── frontend/          # Vue 3 前端
└── docker-compose.yml # PostgreSQL 容器（可选，有 Docker 的机器）
```

## 快速启动

### 1. 后端

```bash
cd backend
npm install
npm run start:dev        # 开发模式（自动执行迁移与种子数据）
```

默认使用 SQLite（`backend/data/campushub.sqlite`），零配置可直接运行。
切换到 PostgreSQL：在 `backend/.env` 中设置 `DB_TYPE=postgres` 并填写连接信息（或使用根目录 `docker-compose.yml`）。

### 2. 前端

```bash
cd frontend
npm install
npm run dev              # 默认 http://localhost:5173
```

### 3. 内置演示账号（种子数据）

| 账号 | 密码 | 角色 |
|------|------|------|
| admin | admin123 | 系统管理员 |
| room_admin | room123 | 教室管理员 |
| ops | ops123 | 运营管理员 |
| maintenance | maint123 | 物业维修员 |
| approver | approve123 | 审批员（M2 多级审批） |
| student | student123 | 学生 |

## 核心业务（雏形覆盖）

- **M1 自习座位预约**：座位搜索（含靠插座筛选）、整点预约（默认最多 4 小时，参数可调）、动态签到码签到、预约前 15 分钟提醒、超时未签到自动取消并记违约、历史查询与复用。
- **M2 整教室预约与审批**：权限门槛、申请提交、多级审批（通过/驳回）、审批通过自动占用座位、驳回/超时自动撤销回滚。
- **M3 物业报修工单**：故障上报、派单、维修中、超时升级、完工验收与评价；维修中自动下架该室座位，验收后恢复。
- **D 公共层**：RBAC 角色权限、用户管理、自习室/座位主数据管理、通知服务、操作审计日志、运营统计。

## 工程化能力（雏形已内置）

- 版本化数据库迁移（TypeORM Migrations），启动自动执行，支持 CLI 手动执行
- 幂等种子数据脚本
- 后端单元/集成测试（Jest + Supertest）
- 流水线脚本（见 `docs/ci.md`）：构建、测试、质量门禁

## 给开发者的下一步

1. 阅读 `docs/requirements.md` 需求基线（含可追踪 ID）与 `docs/decisions/` 决策记录。
2. 按模块认领：M1 / M2 / M3 各自独立目录，D 公共层归属按决策记录分工。
3. 每个模块继续细化需求、补测试、完善 UI，按 AGENTS.md 规则提交与合并。
