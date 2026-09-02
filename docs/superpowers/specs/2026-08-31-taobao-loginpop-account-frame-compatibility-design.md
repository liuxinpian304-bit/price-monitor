# 淘宝账号管理 loginPop 兼容设计

## 背景

淘宝桌面版 `2.4.5` build `15` 的真实可访问性树会常驻一个本地 `pages/loginPop/index.html` WebArea。初始证据中，用户已经登录时该区域标题为“账号管理”，并同时提供“退出登录”和“切换账号”。路径兼容修复通过全部测试后，真实诊断仍然失败；随后三次连续的真实 AX 快照稳定显示同一个 `AXWebArea` 使用 `file:` 协议和 `pages/loginPop/index.html` 终止路径，标题为“登陆”，且同时包含“退出登录”和“切换账号”。用户已批准在原有完整证据门槛下接受这个标题变体。

## 决策

扩展 `isConfirmedAccountManagementFrame` 的本地路径识别，使其同时接受以下两类精确路径形态：

- 既有的 `account-panel/loginPop/index.html`
- 淘宝桌面版真实使用的 `pages/loginPop/index.html`

路径兼容本身不能放行。一个区域只有同时满足以下条件，才会从登录阻塞检测中排除：

1. 节点是 `AXWebArea`，URL 使用 `file:` 协议。
2. URL 路径精确匹配批准的 `loginPop` 账号管理形态。
3. 标题是“账号管理”、`Account Settings` 或“登陆”。
4. 子树同时包含“退出登录”和“切换账号”，或对应英文文本。

“登陆”只有在现有的 `AXWebArea` + `file:` + 精确批准路径 + 两个已登录控件门槛全部满足时才会被接受，不能单独作为放行依据。

任何 HTTP/HTTPS 登录 URL、安全验证 URL、登录标题，或缺少任一账号管理确认信号的本地 `loginPop`，仍按原规则停止。

## 实现范围

- 在真实选择器测试中先加入标题为“登陆”的 `pages/loginPop` 已登录账号管理回归用例，并确认修复前仅正向用例失败。
- 只把“登陆”加入批准的账号管理标题集合，不调整路径、控件证据、登录、安全验证或采集流程的其他行为。
- 运行选择器测试、完整采集器测试和类型检查。
- 重启本地 API 后重新运行 `collector:diagnose`。

## 验收标准

- 标题为“账号管理”、`Account Settings` 或“登陆”的真实 `pages/loginPop` 账号管理区域，在完整证据门槛满足时不再触发登录误判。
- 缺少“退出登录”或“切换账号”的相同路径仍触发 `LoginRequiredError`。
- 既有登录页和安全验证测试继续通过。
- 本机诊断返回 `diagnose_complete` 后，才进入 RME Babyface 前 3 条监督查价试跑。
- 本次修复不发送企业微信消息、不执行自动改价，也不放宽平台验证处理。
