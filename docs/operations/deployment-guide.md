# 天猫比价监控目标态部署手册

> 当前状态：API 已装配 `CollectionScheduler`、BullMQ `Worker`、桌面报告入库、通知批次和 `WecomClient` 工厂，但这只代表自动化运行时可以初始化，不代表真实淘宝或企业微信已经验收。真实淘宝桌面版的 3 条/50 条监督采集和首次真实企业微信发送仍为 **LIVE PENDING**，完成现场验收前不得称为生产上线。

## 1. 上线边界

目标态系统的商品资料、匹配、比价、预警、企业微信消息、运营处理、审计和管理后台均保存在自建环境中。原始商品数据可以来自经过验收的外部 `CommerceProvider`，也可以来自已装配但仍待现场验收的淘宝桌面版采集器；两条路径的密钥、权限和验收记录必须独立管理。

当前仓库包含固定样例数据源、可替换适配器框架和 macOS 淘宝桌面采集运行时。生产上线前仍需为所选路径完成数据来源、鉴权/设备登记、限额、字段映射、价格准确率和端到端验收。桌面路径不得改造成高频网页抓取，不得绕过登录或平台挑战，也不得自动修改淘宝价格。

## 2. 环境要求

- Linux 或 macOS 服务器，建议至少 2 核 CPU、4 GB 内存和 40 GB 磁盘。
- Node.js 22 或以上、pnpm 11、Docker 和 Docker Compose。
- 可访问 PostgreSQL、Redis 和企业微信；选择外部供应商时还需可访问其合规商品数据 API。
- 选择桌面采集时，需一台已登记并获得辅助功能和屏幕录制权限的 Mac，安装批准版本的淘宝桌面版，保持人工登录、窗口可见和屏幕解锁，并由运营人员监督首次运行。
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

建议使用 systemd、Supervisor 或容器编排平台托管 API、队列 Worker 和静态站点；设置自动重启、日志轮转和开机启动。淘宝桌面采集进程只能在已登记、已授权、已登录且保持解锁的受控 Mac 上启动，具体步骤见《[淘宝桌面版采集器操作手册](macos-collector.md)》；不得把无监督桌面进程当作服务器守护任务直接上线。

## 6. 首次配置

1. 使用 `openssl rand -hex 32` 生成 64 位十六进制 `ADMIN_API_TOKEN`，写入服务端秘密配置；点击页面顶栏“管理员解锁”并输入该值，完成配置后点击“锁定”清除当前标签页凭证。
2. 在受控秘密配置中保存企业微信运营群机器人 Webhook；保存配置不等于允许发送，首次真实发送必须在动作发生时重新取得运营确认。
3. 选择外部数据路径时保存独立的外部 API 密钥；选择桌面路径时按操作手册登记 Mac 并只在该 Mac 本地保存一次性配对 token。
4. 在所选数据路径验收通过后，把商品数据源从“手工固定样例”切换为“外部合规数据 API”或“淘宝桌面版采集器”。桌面路径在 3 条和 50 条监督采集完成前仍保持 LIVE PENDING。
5. 核对 12 个检查时间和 `Asia/Shanghai` 时区。
6. 导入 20 至 50 个重点型号，先抽检裸机、同配套装和不同配套装各不少于 10 条。

## 7. 上线检查

```bash
curl -fsS http://127.0.0.1:4100/api/health
curl -fsS http://127.0.0.1:4100/api/health/collection
```

上线门槛：数据库和 Redis 为 `up`；实际模板能导入；低 `0.01 元`能产生一次预警；同价重复扫描不重发；再次降价会重发；不同配置套装进入人工核对；页面和日志不出现密钥明文。

正式扩展全店前，先在运营人员在场时完成桌面路径的 3 条和 50 条验收（或完成外部供应商的等价数据验收），再连续试运行 7 天并核对每天 12 个时点的成功或失败记录。首次真实企业微信发送必须在发送前再次确认，且系统始终只监控和提醒，不自动改价。

## 8. 备份和回滚

每日备份 PostgreSQL，Redis AOF 和应用版本至少保留 7 天。部署前记录数据库迁移版本；应用回滚时不得直接回退已执行的数据库迁移，应先评估 schema 兼容性。

发生严重异常时，先在系统设置暂停自动检查，保留已有预警和证据，再回滚应用。恢复后等待下一计划时点并核对采集记录，不要批量删除历史价格或审计日志。
