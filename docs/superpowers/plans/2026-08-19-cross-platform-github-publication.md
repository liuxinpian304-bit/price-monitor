# 比价工具跨平台与 GitHub 公开发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有比价工具改造成 macOS、Windows、Linux 使用同一套命令运行的公开仓库，并安全发布到 GitHub `liuxinpian304-bit/price-monitor`。

**Architecture:** 使用 Node.js ESM 脚本替代 Unix Shell 文件发现与初始化逻辑，Docker Compose 统一提供 PostgreSQL 和 Redis。GitHub Actions 在三种操作系统上验证便携测试与构建，在 Linux 上补充数据库、Redis 和端到端测试；公开审计脚本负责阻止秘密、本机路径和无关资料进入 Git。

**Tech Stack:** Node.js 22+、pnpm 11、TypeScript、NestJS、React/Vite、Prisma/PostgreSQL、BullMQ/Redis、Docker Compose、GitHub Actions。

## Global Constraints

- GitHub 仓库地址名固定为 `price-monitor`，README 标题固定为“比价工具”。
- 保留“星空乐器专营店”、业务规则、检查时间和产品型号示例。
- 员工姓名、同行店铺、演示价格、商品链接和证据链接必须使用明确的虚构数据。
- 不跟踪真实 `.env`、密钥、Cookie、数据库、录音、销售资料、本机绝对路径、压缩包、依赖目录或构建缓存。
- Windows 使用 PowerShell 和 Docker Desktop；macOS 使用 Terminal 和 Docker Desktop。
- 系统只监控、提醒和留痕，不自动改价；真实天猫搜索仍依赖另行选定的合规 `CommerceProvider`。
- 公开仓库暂不附许可证。

---

### Task 1: 跨平台 API 测试发现器

**Files:**
- Create: `scripts/api-test-files.mjs`
- Create: `scripts/api-test-files.test.mjs`
- Create: `scripts/run-api-tests.mjs`
- Modify: `package.json`
- Rename: PostgreSQL/Redis 测试为 `*.integration.spec.ts`

**Interfaces:**
- Produces: `discoverApiTests(rootDir: string, options?: { portableOnly?: boolean }): Promise<string[]>`，返回按路径排序的绝对测试文件列表。
- Consumes: Node.js `fs/promises` 与 `path`，不调用 shell、`find` 或 `sort`。

- [ ] **Step 1: 写失败测试**

在 `scripts/api-test-files.test.mjs` 使用临时目录创建 `plain.spec.ts`、`db.integration.spec.ts` 和非测试文件，断言完整模式返回两个测试、`portableOnly` 只返回普通测试、结果顺序稳定。

```js
test("discovers API specs portably and can exclude integration specs", async () => {
  const all = await discoverApiTests(root);
  const portable = await discoverApiTests(root, { portableOnly: true });
  assert.deepEqual(all.map(basename), ["db.integration.spec.ts", "plain.spec.ts"]);
  assert.deepEqual(portable.map(basename), ["plain.spec.ts"]);
});
```

- [ ] **Step 2: 验证测试先失败**

Run: `node --test scripts/api-test-files.test.mjs`  
Expected: FAIL，提示 `scripts/api-test-files.mjs` 不存在。

- [ ] **Step 3: 实现递归发现与运行入口**

`discoverApiTests` 递归读取目录，只接受 `.spec.ts`，在便携模式排除 `.integration.spec.ts`。`run-api-tests.mjs` 使用 `spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" })`，无测试或子进程失败时返回非零退出码。

- [ ] **Step 4: 统一集成测试命名与 package scripts**

将数据库和 Redis 测试统一改为 `.integration.spec.ts`，并配置：

```json
{
  "test:api": "node scripts/run-api-tests.mjs",
  "test:api:portable": "node scripts/run-api-tests.mjs --portable",
  "test:portable": "pnpm test:config && pnpm test:contracts && pnpm test:api:portable && pnpm test:web",
  "verify:portable": "pnpm test:portable && pnpm build"
}
```

- [ ] **Step 5: 验证并提交**

Run: `node --test scripts/api-test-files.test.mjs`  
Run: `pnpm test:api:portable`  
Run: `pnpm test:api`  
Expected: 全部 PASS。

```bash
git add scripts package.json apps/api/src
git commit -m "build: make test discovery cross-platform"
```

### Task 2: 跨平台环境初始化与诊断

**Files:**
- Create: `scripts/local-env.mjs`
- Create: `scripts/local-env.test.mjs`
- Create: `scripts/setup.mjs`
- Create: `scripts/doctor.mjs`
- Modify: `package.json`
- Modify: `apps/api/package.json`

**Interfaces:**
- Produces: `createLocalEnv(template: string, masterKey: string): string`，只替换 `SETTINGS_MASTER_KEY`。
- Produces: `checkNodeVersion(version: string, minimumMajor?: number): { ok: boolean; message: string }`。
- `setup.mjs` 仅创建缺失的 `.env`，已有文件时退出成功且不改内容。
- `doctor.mjs` 不输出任何环境变量值或密钥。

- [ ] **Step 1: 写失败测试**

```js
test("creates a local env with a generated key and preserves all public settings", () => {
  const result = createLocalEnv("API_PORT=4100\nSETTINGS_MASTER_KEY=replace-me\n", "a".repeat(64));
  assert.equal(result, `API_PORT=4100\nSETTINGS_MASTER_KEY=${"a".repeat(64)}\n`);
});

test("requires Node 22 or newer", () => {
  assert.equal(checkNodeVersion("v22.12.0").ok, true);
  assert.equal(checkNodeVersion("v20.18.0").ok, false);
});
```

- [ ] **Step 2: 验证测试先失败**

Run: `node --test scripts/local-env.test.mjs`  
Expected: FAIL，提示导出函数不存在。

- [ ] **Step 3: 实现初始化与诊断**

`setup.mjs` 通过 `randomBytes(32).toString("hex")` 生成本地主密钥，使用 `writeFile(..., { flag: "wx" })` 防止覆盖。`doctor.mjs` 使用 `spawnSync` 检查 `pnpm --version`、`docker --version` 和 `docker compose version`，并检查 `.env` 是否存在。

- [ ] **Step 4: 增加统一命令**

```json
{
  "setup": "node scripts/setup.mjs",
  "doctor": "node scripts/doctor.mjs",
  "infra:up": "docker compose -f infra/docker-compose.yml up -d",
  "infra:down": "docker compose -f infra/docker-compose.yml down",
  "db:migrate": "prisma migrate deploy",
  "dev:api": "pnpm --filter @stau-price-monitor/api dev",
  "dev:web": "pnpm --filter @stau-price-monitor/web dev",
  "seed:demo": "pnpm --filter @stau-price-monitor/api seed:demo"
}
```

将 API 的 `seed:demo` 改为 `tsx --tsconfig tsconfig.json src/database/seed-demo.ts`。

- [ ] **Step 5: 验证并提交**

Run: `node --test scripts/local-env.test.mjs`  
Run: `pnpm setup`（验证已有 `.env` 不变）  
Run: `pnpm doctor`  
Expected: 测试通过；诊断明确报告当前组件状态且不显示密钥。

```bash
git add scripts package.json apps/api/package.json
git commit -m "feat: add portable setup and diagnostics"
```

### Task 3: 公开仓库跟踪规则与自动审计

**Files:**
- Create: `.gitignore`
- Create: `.gitattributes`
- Create: `.editorconfig`
- Create: `scripts/public-audit.mjs`
- Create: `scripts/public-audit.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `auditPaths(paths: string[]): string[]`，返回不允许公开的路径错误。
- Produces: `auditText(path: string, content: string): string[]`，返回秘密或本机路径错误，不返回匹配到的秘密原文。
- CLI 使用 `git ls-files -z` 审计实际跟踪文件，任一错误返回退出码 1。

- [ ] **Step 1: 写失败测试**

覆盖 `.env`、`node_modules`、`work/`、`tmp/`、ZIP、录音、销售文件、Unix home-directory 与 Windows drive-rooted home-directory 路径、企业微信完整 Webhook 与非占位密钥。路径与 Webhook fixture 必须由安全片段动态构造；同时允许 `.env.example`、Excel 模板和 `replace-with-a-long-random-secret`。

- [ ] **Step 2: 验证测试先失败**

Run: `node --test scripts/public-audit.test.mjs`  
Expected: FAIL，提示审计模块不存在。

- [ ] **Step 3: 实现 Git 跟踪和文本审计**

审计错误只输出路径和错误类别，例如 `apps/example.ts: possible webhook secret`，不得输出匹配内容。二进制文件只做路径审计。

- [ ] **Step 4: 配置公开仓库文件规则**

`.gitignore` 必须忽略所有依赖、`.env`、构建缓存、`generated/prisma`、`work`、`tmp`、无关 `outputs` 和 ZIP，仅放行 `.env.example` 与 `outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx`。`.gitattributes` 默认 LF，标记 PNG/XLSX/ZIP 为 binary；`.editorconfig` 固定 UTF-8 与 LF。

- [ ] **Step 5: 验证并提交**

Run: `node --test scripts/public-audit.test.mjs`  
Run: `git status --short --ignored`  
Expected: 无关资料均显示 ignored，项目源码与模板可跟踪。

```bash
git add .gitignore .gitattributes .editorconfig scripts package.json
git commit -m "chore: add public repository safeguards"
```

### Task 4: 匿名化公开演示资料

**Files:**
- Modify: `apps/api/src/database/seed-demo.ts`
- Modify: `apps/web/src/data/demo-data.ts`
- Modify: `apps/web/src/data/api-fallbacks.ts`
- Modify: `tests/fixtures/providers/*.json`
- Modify: affected tests under `apps/api/src`, `apps/web/src`, and `tests/e2e`
- Modify: `outputs/tmall-price-monitor/天猫比价监控_运营录入模板.xlsx`
- Create: `scripts/public-demo-data.test.mjs`

**Interfaces:**
- Demo owners use `运营A`、`运营B`、`运营C`。
- Competitor shops use `示例同行店A`、`示例同行店B`、`示例同行店C`。
- Public external URLs use `https://example.com/...`；localhost health/API URLs remain allowed。
- Price relationships remain behaviorally equivalent: lower by one fen alerts, equal/higher does not, another drop alerts again。

- [ ] **Step 1: 写隐私回归测试并确认失败**

`scripts/public-demo-data.test.mjs` 扫描将公开的源码、fixture 和文档，断言不再出现现有员工姓名、同行店铺名称与真实商品域名；解析 Excel 工作表字符串并应用相同断言。

Run: `node --test scripts/public-demo-data.test.mjs`  
Expected: FAIL，并只报告文件与数据类别，不回显敏感文本。

- [ ] **Step 2: 匿名化种子、前端 fallback 与 fixture**

保持产品型号和业务状态不变，把负责人、同行店铺、价格、链接和证据替换为虚构值。同步更新依赖固定文本或金额的测试断言。

- [ ] **Step 3: 匿名化 Excel 模板并验证结构**

保留四张工作表、表头、数据验证、格式和公式，只替换示例行中的负责人、价格、店铺与链接。使用现有 `catalog-import.service.spec.ts` 验证模板仍可被导入器识别。

- [ ] **Step 4: 运行行为与隐私测试**

Run: `node --test scripts/public-demo-data.test.mjs`  
Run: `pnpm test:api`  
Run: `pnpm test:web`  
Run: `pnpm test:e2e`  
Expected: 隐私扫描和全部业务测试 PASS。

- [ ] **Step 5: 提交匿名化改动**

```bash
git add apps tests outputs/tmall-price-monitor scripts/public-demo-data.test.mjs
git commit -m "chore: anonymize public demo data"
```

### Task 5: README、平台指南与三系统 CI

**Files:**
- Create: `README.md`
- Create: `SECURITY.md`
- Create: `docs/operations/windows-setup.md`
- Create: `docs/operations/macos-setup.md`
- Create: `.github/workflows/ci.yml`
- Modify: `docs/operations/deployment-guide.md`
- Modify: `docs/operations/operator-guide.md`

**Interfaces:**
- README 快速启动顺序固定为 `pnpm install`、`pnpm setup`、`pnpm infra:up`、`pnpm db:generate`、`pnpm db:migrate`、`pnpm seed:demo`、分别启动 API/Web。
- CI `portable` job 的 matrix 固定为 `ubuntu-latest`、`macos-latest`、`windows-latest`。
- CI `integration` job 固定使用 PostgreSQL 16、Redis 7、端口 5433/6380。

- [ ] **Step 1: 写文档契约测试**

Create `scripts/public-docs.test.mjs`，断言 README 包含项目边界、Windows/macOS 链接、统一命令、供应商限制；断言 CI 包含三系统矩阵、PostgreSQL 16、Redis 7 和 `pnpm verify`。

- [ ] **Step 2: 验证测试先失败**

Run: `node --test scripts/public-docs.test.mjs`  
Expected: FAIL，提示 README 或 CI 文件不存在。

- [ ] **Step 3: 编写公开文档与安全政策**

README 说明功能、截图、架构、快速启动、测试、真实数据源边界和无许可证状态。Windows 指南使用 PowerShell，macOS 指南使用 Terminal。SECURITY.md 只提供 GitHub 私密漏洞报告入口，不公开个人邮箱。

- [ ] **Step 4: 增加 GitHub Actions**

使用 `actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4`，Node 固定 22、pnpm 固定 11.19.0。便携矩阵执行 `pnpm verify:portable`；Linux 集成任务部署迁移后执行 `pnpm verify`。

- [ ] **Step 5: 验证并提交**

Run: `node --test scripts/public-docs.test.mjs`  
Run: `pnpm verify:portable`  
Expected: PASS。

```bash
git add README.md SECURITY.md docs .github scripts/public-docs.test.mjs
git commit -m "docs: add macOS and Windows setup with CI"
```

### Task 6: 完整验收与 GitHub 公开发布

**Files:**
- Inspect: all Git tracked files
- Publish: GitHub repository `liuxinpian304-bit/price-monitor`

**Interfaces:**
- Remote `origin` points to `https://github.com/liuxinpian304-bit/price-monitor.git` or authenticated equivalent。
- Default branch is `main` and visibility is `public`。

- [ ] **Step 1: 运行最终本机验收**

Run: `pnpm db:validate`  
Run: `pnpm infra:config`  
Run: `pnpm verify`  
Run: `pnpm audit:public`
Expected: 全部 PASS；只允许已知的非阻塞前端 chunk 大小警告。

- [ ] **Step 2: 审计待提交内容**

Run: `git status --short`  
Run: `git ls-files`  
Run: `pnpm audit:public`
Expected: 不存在秘密、本机路径、录音、销售资料、`.env`、ZIP、`node_modules` 或 `generated/prisma`。

- [ ] **Step 3: 提交最终公开快照**

```bash
git add --all
git commit -m "release: prepare price monitor for public use"
```

- [ ] **Step 4: 创建并推送公开仓库**

先确认认证用户为 `liuxinpian304-bit` 且远端不存在同名仓库，再执行：

```bash
gh repo create price-monitor --public --description "比价工具：电商同行价格监控与企业微信预警" --source . --remote origin --push
```

- [ ] **Step 5: 验证远端与 CI**

Run: `gh repo view liuxinpian304-bit/price-monitor --json nameWithOwner,visibility,defaultBranchRef,url`  
Run: `gh run list --repo liuxinpian304-bit/price-monitor --limit 5`  
Expected: 仓库为 PUBLIC、默认分支 `main`、最新提交与本地一致；等待 CI 完成并修复任何跨平台失败。
