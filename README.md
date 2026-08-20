# 比价工具

用于天猫同行价格监控、企业微信提醒和运营处理留痕的本地开发原型。系统只监控、提醒和记录，不自动修改电商平台价格；最终是否调整价格始终由运营人员在平台后台人工决定。

## 当前实现状态

当前仓库可以启动 API 和管理后台，完成演示数据、型号与套装管理、模板导入、匹配与价格规则测试、预警处理留痕、审计及系统配置保存。

当前公开版不会自动执行定时采集，也不会自动发送企业微信消息。生产组合尚未实例化 `CollectionScheduler`、BullMQ `Worker`、`CollectionService`、真实 `CommerceProvider` 或 `WecomClient`；在设置页保存检查时间、数据源和密钥只会持久化配置。部署方完成这些组件的装配、供应商验收和端到端测试之前，不应把本仓库当作无人值守的生产监控服务。

## 功能与架构

- 管理重点型号，区分裸机与套装，并保存目标检查计划。
- 提供具体 SKU 的匹配、到手价和低价预警规则模块及自动化测试；低于我方到手价 `0.01 元` 即符合预警条件。
- 提供企业微信消息构造与客户端、人工处理结果和审计模块，但通知客户端尚未装配到生产运行时。
- `apps/api` 提供管理 API 和领域模块；`apps/web` 提供运营后台；PostgreSQL 保存业务数据，Redis 用于健康检查及已测试的队列组件。

## 运行环境

需要 Node.js 22、pnpm 11.19.0 和 Docker Desktop。macOS 请参阅 [Terminal 设置指南](docs/operations/macos-setup.md)，Windows 请参阅 [PowerShell 设置指南](docs/operations/windows-setup.md)。Linux 可按以下同一套命令运行。

安装依赖并创建本地环境后，使用 `pnpm run doctor` 检查 Node.js、pnpm、Docker、Docker Compose 和 `.env`。必须使用 `pnpm run doctor`：pnpm 11 的裸 `pnpm doctor` 是内置命令冲突，不会运行仓库的环境诊断脚本。

## 快速启动

在仓库根目录依次执行以下命令。`pnpm setup` 只会在 `.env` 不存在时创建它，不会覆盖现有本地配置。

```bash
pnpm install
pnpm setup
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm seed:demo
```

分别在两个终端窗口启动 API 和管理后台：

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

API 默认监听 `http://127.0.0.1:4100`；管理后台开发服务器会在启动后显示本地访问地址。这两个命令启动的是管理与演示界面，不会启动自动采集 Worker。首次启动前，在 `pnpm setup` 之后运行 `pnpm run doctor`，并在 Docker 服务就绪后再执行数据库命令。

演示种子仅用于本地开发，不得用于生产环境。完成运行时装配后的目标部署、反向代理和密钥管理检查清单参阅[目标态部署手册](docs/operations/deployment-guide.md)。

## 测试

```bash
pnpm setup
pnpm db:generate
pnpm verify:portable
```

全新克隆需先运行 `pnpm setup` 创建本地环境，再运行 `pnpm db:generate` 生成 Prisma Client。`pnpm verify:portable` 运行不依赖 PostgreSQL 和 Redis 的跨平台测试、类型检查和前端生产构建。已启动本地基础设施并完成迁移后，可运行完整验证：

```bash
pnpm verify
```

## 真实数据源边界

真实天猫搜索必须由部署方另行选择并验收合规的 `CommerceProvider`，包括数据来源、鉴权、限额、字段映射和价格准确率。此仓库不包含可直接用于真实天猫搜索的供应商，也不提供依赖普通淘宝账号登录的高频网页采集。

仓库仅随附固定 fixtures 和手工导入 fallback，供开发、测试和演示使用。接入真实数据前，请遵守平台规则、供应商合同和适用法律，并完成供应商契约测试和人工抽检。

## 安全与许可证

安全问题请按 [SECURITY.md](SECURITY.md) 中的 GitHub 私密漏洞报告流程提交。请勿在 Issue、截图、日志或普通聊天中发布密钥、Webhook、Cookie 或账号信息。

本仓库目前不附开源许可证。公开可见不表示已授权复制、修改、分发或商业使用；任何授权安排由权利人另行明确。
