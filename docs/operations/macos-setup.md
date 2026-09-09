# macOS Terminal 设置指南

> 本文用于 API、后台和基础设施。要配置和操作淘宝桌面版采集器，请继续阅读 [淘宝桌面采集器操作手册](macos-collector.md)。该采集器的自动化代码已具备，真实淘宝和企业微信验收仍待现场监督完成。

## 1. 安装前准备

安装 Node.js 22、pnpm 11.19.0 和 Docker Desktop。打开 **Terminal**，克隆仓库后进入仓库根目录。

```bash
node --version
pnpm --version
docker --version
docker compose version
```

## 2. 初始化与启动

在 Terminal 中执行：

```bash
pnpm install
pnpm setup
pnpm run doctor
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm seed:demo
```

必须使用 `pnpm run doctor`。pnpm 11 的裸 `pnpm doctor` 会命中内置命令，不能执行本项目的诊断脚本。

分别在两个 Terminal 窗口启动 API 和管理后台：

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

当前 Mac 同时是唯一固定采集机。完成 [淘宝桌面采集器操作手册](macos-collector.md) 中的登记和诊断后，在第三个 Terminal 窗口只在这台 Mac 上启动：

```bash
pnpm collector:worker
```

另一台 Mac 和 Windows 电脑只通过浏览器打开管理后台，不复制 `.env.collector`、不保存采集 token，也不运行 `collector:worker`。这样淘宝桌面版登录会话始终由同一台机器维护，避免多机轮流触发登录和平台验证。

## 3. 验证与停止

```bash
pnpm verify:portable
pnpm infra:down
```

完整验证 `pnpm verify` 需要 PostgreSQL 和 Redis 保持启动且已经完成 `pnpm db:migrate`。本机 `.env`、密钥、Webhook 和真实供应商凭据不得提交到 Git。
