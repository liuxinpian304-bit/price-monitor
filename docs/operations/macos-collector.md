# 淘宝桌面版采集器操作手册

> **状态：AUTOMATED READY / LIVE PENDING。** 调度、采集器注册、报告入库、报告页面和通知批次已有自动化实现；本仓库尚未完成真实淘宝桌面版的 3 条或 50 条监督采集，也没有发送真实企业微信消息。本手册不能替代现场验收，也不允许自动改价。

## 1. 使用边界

- 采集器只采集、报告和触发受控通知批次；价格调整始终由运营人员在电商后台人工完成。
- 首次真实淘宝采集必须有运营人员在场。登录失效、平台挑战、页面异常或选择器变化时立刻停止，不得绕过验证。
- 首次真实企业微信 Webhook 发送必须在发送前重新取得运营确认。
- 当前仅接受 macOS 桌面采集器。Windows 采集器和三机生产分片尚未验收。

## 2. 前置条件与权限

1. 在此 Mac 上准备 Node.js 22、pnpm 11.19.0、Docker Desktop，以及可构建 `apps/collector-macos` 的完整 Xcode 工具链。
2. 使用已批准的淘宝桌面版 `2.4.5` build `15`，打开应用并保持登录、前台窗口可见、屏幕未锁定。
3. 在 **系统设置 -> 隐私与安全性 -> 辅助功能** 中允许启动 `taobao-ax-helper` 的终端或进程控制界面。
4. 在 **系统设置 -> 隐私与安全性 -> 屏幕录制** 中允许同一终端或采集器启动进程。修改权限后退出并重新打开相关进程，再运行诊断。
5. API、PostgreSQL 和 Redis 必须已经启动，且 API 健康接口可达。`runtime: "ASSEMBLED"` 只证明 API 初始化完成，不证明淘宝页面已验收。

## 3. 登记 Mac 与保存一次性 token

`POST /api/collector-agents` 只允许来自 API 主机的 loopback 请求并要求管理员权限。请在运行 API 的本机管理员会话中登记每一台 Mac，登记返回的一次性 token 只显示一次。

把 [`.env.collector.example`](../../.env.collector.example) 复制为仓库根目录的本地 `.env.collector`，再填写下列字段：

```dotenv
COLLECTOR_API_URL=http://127.0.0.1:4100
COLLECTOR_PAIRING_TOKEN=<登记时仅显示一次的 token>
COLLECTOR_NAME=<唯一的 Mac 名称>
COLLECTOR_WORK_DIR=work/collector-runs
TAOBAO_AX_HELPER_PATH=apps/collector-macos/.build/debug/taobao-ax-helper
```

`.env.collector` 已被 Git 忽略。不要把 token 写入 Git、终端截图、日志、聊天记录或问题单；也不要把 token 放入 `.env.example`。普通 HTTP API 地址只接受 loopback；远程 API 必须使用受保护的 HTTPS 部署。

## 4. 诊断、单次与 Worker

在仓库根目录执行以下命令。先完成诊断；当前任务不执行真实淘宝操作时，不要继续运行 `once` 或 `worker`。

```bash
pnpm collector:diagnose
pnpm collector:once
pnpm collector:worker
```

- `diagnose` 检查 helper 可执行性、API 可达性、配对 token、辅助功能、淘宝进程、版本/build、前台窗口和登录状态；它不会领取任务。
- `once` 最多领取一个排队任务，完成或暂停后退出。
- `worker` 持续领取任务；仅在经过现场批准的 Mac 上启动，并通过 `Ctrl+C` 正常停止。

## 5. 登录、挑战与重新入队

当报告状态为 `PAUSED_LOGIN`：在原登记 Mac 上手动恢复淘宝登录，确认搜索结果页已可用，再由管理员在“采集报告”中点击“重新入队”。

当报告状态为 `PAUSED_CHALLENGE`：在原登记 Mac 上按平台要求完成验证，确认已回到搜索结果页，再由管理员重新入队。

只有这两个暂停状态提供重新入队。`RUNNING`、`SUCCEEDED`、`PARTIAL_FAILED` 和 `FAILED` 没有该按钮；不得通过脚本模拟登录、验证码或平台挑战。重新入队保留该任务的受控恢复语义，不会跳过平台步骤。

## 6. 查看完整报告与证据

管理员登录后台后访问“采集报告”：

1. `/runs` 显示运行状态、请求位置数、已捕获位置、未完成数、唯一商品、SKU、采集器和通知状态。
2. `/runs/:runId` 显示按排名排序的搜索位置，以及每个 SKU 独立的价格组件、库存、匹配决策、比价结论、问题和证据入口。
3. `47 / 50，未完成` 表示不能把该运行当作完整 50 条结果。所有未完成项和问题都需要人工复核。
4. 证据链接只向管理员开放；服务只接受该运行已引用的 SHA-256，返回私有、禁止缓存的 PNG，绝不返回本机文件路径。

真实运行产生的截图、报告和检查点只保存在被忽略的 `work/collector-runs/` 与 `work/collector-evidence/`，不得提交到 Git。

## 7. 停用或撤销采集器

设备遗失、退役或疑似泄漏时，立即：

1. 停止该 Mac 的 `pnpm collector:worker` 进程。
2. 删除该 Mac 本地 `.env.collector` 中的 token，并从终端历史、截图和日志中清除敏感副本。
3. 由部署管理员在受控数据库运维流程中将对应 `CollectorAgent.enabled` 设为 `false`，或按组织的凭据轮换流程创建新 agent/token。
4. 验证旧 token 无法通过诊断配对或领取任务，再登记新设备。

当前仓库没有公开的 agent 撤销页面或远程登记回退接口；这是一项明确的部署管理员操作，不应通过临时改代码或共享 token 绕过。

## 8. 常见诊断结果

| 结果 | 处理 |
| --- | --- |
| `ACCESSIBILITY_PERMISSION_REQUIRED` | 重新授予辅助功能权限，重启终端/采集进程后重试 `diagnose`。 |
| `TAOBAO_NOT_RUNNING` | 启动淘宝桌面版并登录。 |
| `TAOBAO_LOGIN_REQUIRED` | 在应用中手动登录，不要把账号密码交给采集器。 |
| `TAOBAO_WINDOW_UNAVAILABLE` | 将淘宝主窗口置前且保持屏幕解锁。 |
| `TAOBAO_VERSION_UNSUPPORTED` | 停止 worker，回到批准的 `2.4.5` build `15` 或更新经过验收的选择器配置。 |
| `PAUSED_LOGIN` 或 `PAUSED_CHALLENGE` | 按第 5 节手动恢复，再由管理员重新入队。 |
| API/配对失败 | 检查 API、PostgreSQL、Redis 和本地 token；不得在错误反馈中粘贴 token。 |

## 9. 自动化页面回归

以下命令使用仓库内脱敏 fixture 验证 `/runs` 和 `/runs/:runId` 的桌面端及 `390px` 布局、管理员解锁恢复、表格横向滚动和控制台错误。它只启动本地预览站点并拦截本地 `/api` 请求，不会运行淘宝桌面版，也不会发送企业微信消息。

```bash
pnpm exec playwright install chromium
pnpm test:browser
```

首次安装 Chromium 后，日常只需执行 `pnpm test:browser`。自动化通过不代表真实淘宝或企业微信验收完成。

## 10. 现场验收待办

以下项目仍是 **LIVE PENDING**，完成前不得对外称“真实采集已上线”：

- 在运营人员在场时完成 3 条 Sony MDR-7506 监督采集，并人工核对搜索位置、链接、活动价、全部可访问 SKU、检查点清理和报告页面。
- 再完成 50 条或明确提前页尾的监督采集，抽检排名 1、13、25、37 和最终排名。
- 在发送前取得新的运营确认后，仅发送一条真实企业微信试点摘要；验证重复报告不会重复发送。
- 核验真实证据始终留在被忽略的本地 `work/` 目录，Git 中不含价格、店铺、账号、截图或 token。
