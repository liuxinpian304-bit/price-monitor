# 本地演示运行链路修复设计

## 背景

本地演示暴露出两个可稳定复现的问题：

1. `pnpm seed:demo` 通过 pnpm workspace filter 在 `apps/api` 目录运行，`dotenv/config` 因此找不到仓库根目录的 `.env`，最终报错 `DATABASE_URL is required`。
2. 前端把 `本地运营`、`本地管理员` 直接写入 `x-actor-id` 请求头。浏览器要求请求头值可表示为 ISO-8859-1，中文字符会在发送前触发 `Headers` 异常，导致预警处理、型号修改和系统设置等写操作无法提交。

本次只修复本地开发原型的运行链路，不引入正式用户登录、权限服务或真实平台数据源。

## 方案比较

### 方案 A：带前缀的 URI 编码身份头（采用）

前端将中文操作员编号写成 `uri:<encodeURIComponent(actorId)>`；API 只对带 `uri:` 前缀的值解码。没有前缀的现有 ASCII 编号保持原样。

优点：改动集中、保留中文审计记录、兼容现有 API 测试和外部 ASCII 调用方。缺点：仍属于开发原型的临时身份传递方式，不能替代正式认证。

### 方案 B：前端统一改用 ASCII 编号

把 `本地运营` 和 `本地管理员` 改为 `local-operator`、`local-admin`。

优点：实现最简单。缺点：审计记录失去当前界面使用的中文操作员标识，并要求逐个修改调用位置。

### 方案 C：把操作员身份移入请求体或正式会话

优点：长期协议更清晰。缺点：需要修改多个 DTO、控制器和认证边界，明显超出这次本地演示修复范围。

## 已选设计

### 1. 身份头编码

`apps/web/src/api/client.ts` 在统一请求入口编码 `actorId`：

```text
本地运营 -> uri:%E6%9C%AC%E5%9C%B0%E8%BF%90%E8%90%A5
local-operator -> uri:local-operator
```

所有现有页面继续传原来的中文名称，不需要分散修改。

### 2. API 身份头解码

`apps/api/src/http/identity.ts` 增加一个纯函数：

- 值以 `uri:` 开头时，解码后再去除首尾空白。
- 值没有 `uri:` 前缀时，保留当前 ASCII 行为。
- 编码损坏、解码结果为空或请求头缺失时，回退到 `local-operator`。
- `x-role` 的现有处理不变。

这能避免无效编码污染审计记录，同时保持旧客户端兼容。

### 3. 根目录环境文件加载

`apps/api/package.json` 的 `dev`、`start` 和 `seed:demo` 改用 Node.js 22 自带的 `--env-file=../../.env`，并通过 `--import=tsx` 执行 TypeScript。开发模式继续使用 Node 的 `--watch`。

根目录命令保持不变：

```bash
pnpm dev:api
pnpm seed:demo
```

脚本不会读取或打印密钥值；`.env` 仍由 `pnpm setup` 创建且不进入 Git。

## 数据流

1. 页面调用 `apiRequest`，传入中文 `actorId`。
2. `apiRequest` 写入只含 ASCII 的 `x-actor-id`。
3. API 的 `requestIdentity` 解码并得到原始中文操作员名称。
4. 领域服务和审计仓库继续接收原有 `actorId` 字符串。
5. 本地 API 和种子脚本从仓库根目录 `.env` 获取数据库、Redis 和本地主密钥配置。

## 测试

1. Web 单元测试断言中文 `actorId` 不会在构造 `Headers` 时抛错，并验证发送值带 `uri:` 前缀且只含 ASCII。
2. API 单元测试覆盖中文解码、旧 ASCII 值兼容、损坏编码回退和缺失值回退。
3. 脚本契约测试断言 API 的三个运行命令都显式加载 `../../.env`。
4. 运行全部公开脚本测试、`pnpm verify:portable` 和公开审计。
5. 在浏览器重新执行“打开预警 -> 选择继续观察 -> 填写中文备注 -> 确认处理”，确认页面成功提示并刷新状态。

## 验收标准

- `pnpm seed:demo` 可从仓库根目录直接成功执行。
- `pnpm dev:api` 可从仓库根目录启动并读取现有 `.env`。
- 中文运营名的页面写操作可以正常提交，审计仍保存中文名称。
- 旧的 ASCII `x-actor-id` 调用保持兼容。
- 不输出 `.env`、密钥或请求头中的敏感值。
- 便携测试、构建、公开审计和浏览器回归全部通过。

## 明确不做

- 不实现正式登录、单点登录或企业微信身份认证。
- 不改变角色模型和数据库结构。
- 不接入真实天猫数据源，也不启用自动采集或企业微信自动发送。
- 不顺带处理 Ant Design 的 `Alert.message` 弃用提示。
