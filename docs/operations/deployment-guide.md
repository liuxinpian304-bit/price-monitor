# 天猫比价监控目标态部署手册

> 当前状态：本文描述的是完成运行时装配后的生产目标态，不是当前公开提交可直接上线的承诺。当前公开版尚未装配 `CollectionScheduler`、BullMQ `Worker`、`CollectionService`、真实 `CommerceProvider` 和 `WecomClient`，因此启动 API 与管理后台不会自动采集或发送企业微信消息。必须由开发人员完成组合根、后台进程、供应商适配和端到端验收后，才能执行本文的生产上线步骤。

## 1. 上线边界

目标态系统的商品资料、匹配、比价、预警、企业微信消息、运营处理、审计和管理后台均保存在自建环境中。自动搜索天猫所需的原始商品数据必须来自合规的外部 `CommerceProvider`。

当前仓库包含固定样例数据源、可替换适配器框架和已测试的领域组件。生产上线前仍需完成运行时装配，选定供应商，并完成接口地址、鉴权、限额、字段映射、数据来源说明和价格准确率验收。不要重新申请淘宝客权限，也不要接入依赖普通淘宝账号登录的高频网页采集。

## 2. 环境要求

- Linux 或 macOS 服务器，建议至少 2 核 CPU、4 GB 内存和 40 GB 磁盘。
- Node.js 22 或以上、pnpm 11、Docker 和 Docker Compose。
- 可访问 PostgreSQL、Redis、企业微信和合规商品数据 API。
- 内网域名或 HTTPS 反向代理，以及公司统一身份认证。

本地 macOS 和 Windows 初始化分别参阅《[macOS Terminal 设置指南](macos-setup.md)》和《[Windows PowerShell 设置指南](windows-setup.md)》。两者使用同一套 pnpm 命令与 Docker Compose 配置。

## 3. 环境变量

复制 `.env.example` 为 `.env`，至少修改以下内容：

```dotenv
POSTGRES_PASSWORD=<高强度数据库密码>
DATABASE_URL=postgresql://price_monitor:<密码>@127.0.0.1:5433/price_monitor?schema=public
REDIS_PORT=6380
API_PORT=4100
SETTINGS_MASTER_KEY=<至少32字节随机密钥>
NODE_ENV=production
```

可用 `openssl rand -hex 32` 生成 `SETTINGS_MASTER_KEY`。该密钥只放在服务器秘密管理系统或进程环境中，不提交到 Git，不写入 Excel，不发送到企业微信群。

## 4. 安装和初始化

```bash
pnpm install --frozen-lockfile
pnpm run doctor
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm db:generate
pnpm db:migrate
pnpm verify
pnpm build
```

项目环境诊断必须使用 `pnpm run doctor`。pnpm 11 会将裸 `pnpm doctor` 解析为 pnpm 内置命令，而不会运行仓库的 `scripts/doctor.mjs`。

生产环境禁止运行 `seed:demo`。首次上线前应备份数据库，并确认 PostgreSQL 与 Redis 健康检查均为 `healthy`。

## 5. 启动服务

```bash
pnpm --filter @stau-price-monitor/api start
pnpm --filter @stau-price-monitor/web build
```

API 默认只监听 `127.0.0.1:4100`。将 `apps/web/dist` 作为静态站点发布，并由同一个 HTTPS 反向代理把 `/api/` 转发到 API。代理必须接入公司身份认证，并覆盖客户端提交的身份和角色请求头。

建议使用 systemd、Supervisor 或容器编排平台托管 API、采集 Worker 和静态站点；设置自动重启、日志轮转和开机启动。

## 6. 首次配置

1. 用管理员身份进入“系统设置”。
2. 保存企业微信运营群机器人 Webhook。
3. 保存外部数据 API 密钥。
4. 在供应商适配器验收通过后，把商品数据源从“手工固定样例”切换为“外部合规数据 API”。
5. 核对 12 个检查时间和 `Asia/Shanghai` 时区。
6. 导入 20 至 50 个重点型号，先抽检裸机、同配套装和不同配套装各不少于 10 条。

## 7. 上线检查

```bash
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:4100/api/health/collection
```

上线门槛：数据库和 Redis 为 `up`；实际模板能导入；低 `0.01 元`能产生一次预警；同价重复扫描不重发；再次降价会重发；不同配置套装进入人工核对；页面和日志不出现密钥明文。

正式扩展全店前，先连续试运行 7 天并核对每天 12 个时点的成功或失败记录。

## 8. 备份和回滚

每日备份 PostgreSQL，Redis AOF 和应用版本至少保留 7 天。部署前记录数据库迁移版本；应用回滚时不得直接回退已执行的数据库迁移，应先评估 schema 兼容性。

发生严重异常时，先在系统设置暂停自动检查，保留已有预警和证据，再回滚应用。恢复后等待下一计划时点并核对采集记录，不要批量删除历史价格或审计日志。
