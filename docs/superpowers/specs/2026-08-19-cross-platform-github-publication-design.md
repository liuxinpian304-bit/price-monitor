# 比价工具跨平台与 GitHub 公开发布设计

日期：2026-08-19  
GitHub 仓库名：`price-monitor`  
README 项目标题：比价工具  
目标平台：macOS、Windows、Linux

## 1. 目标

将现有天猫同行价格监控项目整理为可公开发布、可在两台 Mac 和一台 Windows 电脑上使用同一套源码运行的仓库。项目继续坚持只监控、提醒和记录，不自动修改电商平台价格。

## 2. 跨平台运行方案

采用 Node.js、pnpm 和 Docker Desktop 的原生跨平台方案。PostgreSQL 与 Redis 使用同一份 Docker Compose 配置；API、管理后台、测试和构建均通过 pnpm 脚本启动。

移除依赖 Unix Shell 的命令，例如 `$(find ...)`。API 测试文件由 Node.js 脚本递归发现并以稳定顺序交给 Node 测试运行器，因此 PowerShell、命令提示符、zsh 和 bash 均能执行同一个命令。

新增跨平台环境初始化和环境诊断脚本：初始化脚本仅在 `.env` 不存在时从示例配置生成本地配置，并创建随机主密钥；诊断脚本检查 Node.js、pnpm、Docker、Docker Compose、环境文件和关键端口配置，不读取或输出秘密明文。

## 3. 开发与运行命令

仓库提供统一入口：

- `pnpm setup`：创建本地 `.env`，不覆盖已有配置。
- `pnpm doctor`：检查本机运行条件。
- `pnpm infra:up` / `pnpm infra:down`：启停 PostgreSQL 与 Redis。
- `pnpm db:generate` / `pnpm db:migrate`：生成 Prisma 客户端并部署迁移。
- `pnpm dev:api` / `pnpm dev:web`：分别启动 API 和管理后台。
- `pnpm test:portable`：执行不依赖数据库和 Redis 的跨平台测试。
- `pnpm verify`：执行完整测试、类型检查和生产构建。

Windows 文档使用 PowerShell 示例，macOS 文档使用 Terminal 示例。两种系统不需要维护不同代码分支。

## 4. 测试分层与持续集成

需要 PostgreSQL 或 Redis 的测试统一使用 `.integration.spec.ts` 后缀；其他测试视为便携测试。

GitHub Actions 包含两层：

1. Windows、macOS、Linux 三系统矩阵执行依赖安装、Prisma 生成、便携测试、类型检查和前端生产构建。
2. Linux 集成任务启动 PostgreSQL 16 与 Redis 7，部署迁移并执行完整测试和端到端验收。

任一平台构建失败或集成规则失败，持续集成均失败。

## 5. 公开仓库隐私边界

保留“星空乐器专营店”、项目功能、业务规则、检查时间和产品型号示例。以下信息全部改为明确的虚构演示数据：

- 员工姓名和负责人。
- 同行店铺名称。
- 商品价格、优惠和库存记录。
- 商品、证据和供应商链接。

公开仓库不得包含真实 `.env`、Webhook、API 密钥、登录信息、Cookie、数据库、录音、销售报表、转写结果、本机绝对路径、压缩交付包、依赖目录或构建缓存。

仓库暂不附开源许可证。公开可见不表示已授权复制、修改或商业使用，后续由公司单独决定是否采用开源许可证。

## 6. 仓库内容

公开仓库包含：

- API、管理后台、共享配置与契约源码。
- Prisma schema、迁移和生成配置。
- Docker Compose 开发基础设施。
- 单元测试、集成测试、端到端测试和脱敏 fixture。
- 脱敏 Excel 运营模板。
- 中文 README、Windows/macOS 启动指南、部署手册和安全说明。
- GitHub Actions 工作流、`.gitignore`、`.gitattributes` 与 `.editorconfig`。

已有本地 `outputs` 中与项目无关的会议、录音和销售资料不进入 Git。

## 7. 错误处理

环境初始化不覆盖现有 `.env`。诊断失败时返回非零退出码，并说明缺失组件或下一条修复命令。测试发现脚本在未找到测试文件时失败，避免误报成功。GitHub 发布前执行秘密扫描、Git 跟踪文件审计和完整测试。

若 GitHub 上已经存在同名仓库，停止创建并先核对归属，不覆盖或删除远端内容。推送后再次读取仓库可见性、默认分支和最新提交，确认仓库为公开且 `main` 已同步。

## 8. 验收标准

- macOS 本机完整测试通过。
- GitHub Actions 的 Windows、macOS、Linux 便携任务通过。
- Linux 数据库与 Redis 集成任务通过。
- Windows 文档只使用 PowerShell 可执行命令。
- Git 跟踪文件中没有真实秘密、本机绝对路径或无关业务资料。
- Excel 模板和演示数据完成匿名化。
- GitHub 公开仓库名为 `price-monitor`，README 标题为“比价工具”，默认分支为 `main`。
