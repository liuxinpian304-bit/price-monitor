# Windows PowerShell 设置指南

## 1. 安装前准备

安装 Node.js 22、pnpm 11.19.0 和 Docker Desktop。打开 **PowerShell**，克隆仓库后进入仓库根目录。

```powershell
node --version
pnpm --version
docker --version
docker compose version
```

## 2. 初始化与启动

在 PowerShell 中执行：

```powershell
pnpm install
pnpm setup
pnpm run doctor
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm seed:demo
```

必须使用 `pnpm run doctor`。pnpm 11 的裸 `pnpm doctor` 会命中内置命令，不能执行本项目的诊断脚本。

分别在两个 PowerShell 窗口启动 API 和管理后台：

```powershell
pnpm dev:api
```

```powershell
pnpm dev:web
```

## 3. 验证与停止

```powershell
pnpm verify:portable
pnpm infra:down
```

完整验证 `pnpm verify` 需要 PostgreSQL 和 Redis 保持启动且已经完成 `pnpm db:migrate`。本机 `.env`、密钥、Webhook 和真实供应商凭据不得提交到 Git。
