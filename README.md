# 比价工具

用于天猫同行价格监控、企业微信提醒和运营处理留痕的本地开发原型。系统只监控、提醒和记录，不自动修改电商平台价格；最终是否调整价格始终由运营人员在平台后台人工决定。

## 当前实现状态

当前仓库可以启动 API 和管理后台，完成演示数据、型号与套装管理、模板导入、匹配与价格规则测试、预警处理留痕、审计及系统配置保存。API 运行时已装配桌面采集的调度、队列、采集器注册、报告入库和通知批次；`/api/health` 返回 `runtime: "ASSEMBLED"` 仅表示这些本地运行时组件已成功初始化。

**真实验收仍未完成。** 本仓库尚未在真实淘宝桌面版上执行 3 条或 50 条监督采集，也没有发送真实企业微信消息。真实运行仍需要一台已登记、已授权、已登录且保持解锁的 Mac 采集器；首次真实企业微信 Webhook 发送必须在执行时重新取得运营确认。Windows 采集器和三机生产分片均尚未验收。系统始终只监控、提醒和记录，绝不自动改价。

## 功能与架构

- 管理重点型号，区分裸机与套装，并保存目标检查计划。
- 提供具体 SKU 的匹配、到手价和低价预警规则模块及自动化测试；低于我方到手价 `0.01 元` 即符合预警条件。
- 提供企业微信消息构造、通知批次、人工处理结果和审计模块；真实 Webhook 的可达性与运营群验收仍待现场完成。
- `apps/api` 提供管理 API、桌面采集调度和报告处理；`apps/web` 提供运营后台与采集报告；PostgreSQL 保存业务数据，Redis 用于健康检查和队列。

## 运行环境

需要 Node.js 22、pnpm 11.19.0 和 Docker Desktop。macOS 请参阅 [Terminal 设置指南](docs/operations/macos-setup.md) 和 [淘宝桌面采集器操作手册](docs/operations/macos-collector.md)，Windows 请参阅 [PowerShell 设置指南](docs/operations/windows-setup.md)。Linux 可按以下同一套命令运行。

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

API 默认监听 `http://127.0.0.1:4100`；管理后台开发服务器会在启动后显示本地访问地址。API 会装配桌面采集调度与报告处理，但不会替你启动 Mac 采集器进程，也不表示已经通过真实淘宝或企业微信验收。首次启动前，在 `pnpm setup` 之后运行 `pnpm run doctor`，并在 Docker 服务就绪后再执行数据库命令。

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

采集报告页面另有完全脱敏的可移植浏览器回归夹具。首次在一台开发机安装依赖后下载锁定版本的 Chromium，再执行桌面和 `390px` 两种布局测试；该夹具只拦截本地 `/api` 请求，不连接淘宝或企业微信：

```bash
pnpm exec playwright install chromium
pnpm test:browser
```

## 真实数据源边界

真实商品搜索可以选择另行验收的合规 `CommerceProvider`，也可以选择已装配但仍处于 LIVE PENDING 的淘宝桌面版采集器。外部路径需验收数据来源、鉴权、限额、字段映射和价格准确率；桌面路径需使用已登记、已授权、已登录且保持解锁的受控 Mac，在运营人员监督下完成 3 条和 50 条现场验收。两条路径都不得变成依赖普通账号的高频网页抓取，首次真实企业微信发送都必须在动作发生时再次取得确认。

仓库仅随附固定 fixtures 和手工导入 fallback，供开发、测试和演示使用。接入真实数据前，请遵守平台规则、供应商合同和适用法律，并完成供应商契约测试和人工抽检。

## 安全与许可证

安全问题请按 [SECURITY.md](SECURITY.md) 中的 GitHub 私密漏洞报告流程提交。请勿在 Issue、截图、日志或普通聊天中发布密钥、Webhook、Cookie 或账号信息。

本仓库目前不附开源许可证。公开可见不表示已授权复制、修改、分发或商业使用；任何授权安排由权利人另行明确。
