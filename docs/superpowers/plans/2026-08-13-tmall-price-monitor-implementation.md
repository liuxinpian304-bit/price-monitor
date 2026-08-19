# 天猫同行比价监控系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成一套面向星空乐器专营店的天猫同行比价系统，自动搜索整个天猫，分开比较裸机和套装，在任何可比同行价格低于我方时通知企业微信运营群，由运营人工处理。

**Architecture:** 使用模块化单体架构：后台 API、任务调度和管理页面部署在同一应用中，PostgreSQL 保存商品、匹配、价格历史、预警和审计数据，Redis 提供任务队列与锁。天猫公开商品数据通过可替换的外部 `CommerceProvider` API 适配器接入；供应商只提供原始数据，匹配、比价、预警和运营数据全部保留在自建系统中。

**Tech Stack:** TypeScript、Node.js 22 LTS、NestJS、PostgreSQL 16、Prisma、Redis、BullMQ、React、Vite、Ant Design、Vitest、Playwright、Docker Compose

## Global Constraints

- 第一期只监控天猫和星空乐器专营店，不覆盖其他平台。
- 第一期不使用淘宝客 API，也不开发依赖淘宝账号登录的网页采集程序。
- 外部数据 API 必须通过字段完整性、价格准确率、更新频率、限额和数据来源说明审查后才能进入生产环境。
- 系统只监控、提醒和记录，不自动修改天猫商品价格。
- 裸机和套装必须分开归类、分开比价。
- 只有明确可比的裸机或同配置套装触发确定低价；不同配置套装只触发人工核对。
- 当 `同行可比价 < 我方可比价` 时预警，不设最低金额或比例门槛。
- 同一同行商品、SKU、价格只通知一次；同行再次降价时重新通知。
- 每天在 `09:30、10:30、11:30、12:30、13:30、14:30、15:30、16:30、17:30、18:30、22:30、03:30` 执行，时区为 `Asia/Shanghai`。
- 企业微信统一发送到一个运营群，Webhook 加密保存，不出现在 Excel 或明文日志中。
- 价格缺失、供应商限流、字段缺失或契约变化必须记为采集失败，不能当作低价。
- 第一批由运营通过 Excel 导入 20 至 50 个重点型号。
- 所有金额以人民币分为数据库存储单位，API 使用整数，页面格式化为元。

---

## Planned File Structure

```text
apps/
  api/src/
    catalog/            # 监控型号、别名、套装资料与 Excel 导入
    collection/         # 调度、采集任务、天猫适配器和采集日志
    matching/           # 型号过滤、裸机/套装分类、可比性判断
    pricing/            # 到手价、套装签名和折算参考价
    alerts/             # 预警生成、去重、企业微信通知和处理状态
    audit/              # 操作日志
  web/src/
    pages/              # 总览、型号、比价、预警、历史和设置页面
    features/           # 各业务模块的 UI 和 API hooks
packages/
  contracts/            # 前后端共享 DTO、枚举和 Zod schema
  config/               # 环境变量、时间计划和常量
prisma/
  schema.prisma         # 数据模型和索引
tests/
  fixtures/             # 脱敏的搜索页、商品页、Excel 和微信消息样例
  e2e/                  # 关键运营流程测试
infra/
  docker-compose.yml    # 本地 PostgreSQL、Redis 和应用服务
docs/
  operations/           # 部署、账号、采集故障和运营手册
```

### Task 1: 项目骨架、共享契约与运行环境

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `apps/api/package.json`
- Create: `apps/web/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/config/src/schedule.ts`
- Create: `infra/docker-compose.yml`
- Test: `packages/config/src/schedule.test.ts`

**Interfaces:**
- Produces: `ComparisonType = "BARE" | "BUNDLE"`
- Produces: `AlertStatus = "PENDING" | "PRICE_CHANGED" | "NO_FOLLOW" | "FALSE_POSITIVE" | "WATCHING"`
- Produces: `CHECK_TIMES: readonly string[]`
- Produces: `moneyFromYuan(value: string): number`

- [ ] **Step 1: 写调度和金额转换失败测试**

```ts
expect(CHECK_TIMES).toEqual([
  "03:30", "09:30", "10:30", "11:30", "12:30", "13:30",
  "14:30", "15:30", "16:30", "17:30", "18:30", "22:30",
]);
expect(moneyFromYuan("5999.90")).toBe(599990);
```

- [ ] **Step 2: 运行 `pnpm vitest packages/config/src/schedule.test.ts`，确认因模块不存在而失败**
- [ ] **Step 3: 建立 workspace、共享枚举、金额转换和 12 个检查时间常量**
- [ ] **Step 4: 运行测试，并启动 `docker compose -f infra/docker-compose.yml config` 验证配置**
- [ ] **Step 5: 提交 `chore: scaffold tmall price monitor`**

### Task 2: 数据库模型和审计基础

**Files:**
- Create: `prisma/schema.prisma`
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/audit.service.spec.ts`
- Create: `apps/api/src/database/prisma.service.ts`

**Interfaces:**
- Consumes: `ComparisonType`, `AlertStatus`
- Produces: Prisma 模型 `MonitoredModel`, `ModelAlias`, `Bundle`, `BundleItem`, `OwnListing`, `SearchCandidate`, `OfferSnapshot`, `CollectionRun`, `PriceAlert`, `AlertAction`, `SystemSetting`, `AuditLog`
- Produces: `AuditService.record(actorId, action, entityType, entityId, before, after): Promise<void>`

- [ ] **Step 1: 写失败测试，要求修改监控规则后产生包含 before/after 的审计记录**
- [ ] **Step 2: 运行 `pnpm --filter api test audit.service.spec.ts`，确认失败**
- [ ] **Step 3: 编写 Prisma 模型、唯一索引和 `AuditService`**
- [ ] **Step 4: 执行 `pnpm prisma validate`、迁移测试库并运行单测**
- [ ] **Step 5: 提交 `feat: add catalog and alert data model`**

### Task 3: Excel 模板导入与逐行校验

**Files:**
- Create: `apps/api/src/catalog/import/catalog-import.service.ts`
- Create: `apps/api/src/catalog/import/catalog-import.controller.ts`
- Create: `apps/api/src/catalog/import/catalog-import.schema.ts`
- Create: `apps/api/src/catalog/import/catalog-import.service.spec.ts`
- Create: `tests/fixtures/catalog-valid.xlsx`
- Create: `tests/fixtures/catalog-invalid.xlsx`

**Interfaces:**
- Produces: `CatalogImportResult { imported: number; updated: number; errors: ImportRowError[] }`
- Produces: `ImportRowError { sheet: string; row: number; field: string; message: string }`
- Consumes: 四张表 `监控型号`, `套装明细`, `型号别名`, `填写说明`

- [ ] **Step 1: 写失败测试，覆盖有效导入、重复监控编号、套装缺少明细、非法枚举和别名引用不存在型号**
- [ ] **Step 2: 运行导入服务测试，确认失败**
- [ ] **Step 3: 实现表头校验、行级 Zod 校验、事务导入和可读错误列表**
- [ ] **Step 4: 运行测试，确认有效模板全部导入且无效模板定位到具体工作表、行和字段**
- [ ] **Step 5: 提交 `feat: import monitored models from excel`**

### Task 4: 商品资料管理 API

**Files:**
- Create: `apps/api/src/catalog/catalog.controller.ts`
- Create: `apps/api/src/catalog/catalog.service.ts`
- Create: `apps/api/src/catalog/catalog.dto.ts`
- Create: `apps/api/src/catalog/catalog.service.spec.ts`

**Interfaces:**
- Produces: `GET /catalog/models`, `POST /catalog/models`, `PATCH /catalog/models/:id`, `POST /catalog/models/:id/toggle`
- Produces: `GET /catalog/models/:id/bundles`, `GET /catalog/models/:id/aliases`
- Consumes: `AuditService.record(...)`

- [ ] **Step 1: 写失败测试，覆盖新增、编辑、启停、裸机套装互斥规则和审计记录**
- [ ] **Step 2: 运行 catalog 服务测试，确认失败**
- [ ] **Step 3: 实现 DTO 校验、服务方法和 REST API**
- [ ] **Step 4: 运行服务和控制器测试，确认所有状态码及错误信息符合约定**
- [ ] **Step 5: 提交 `feat: manage monitored catalog`**

### Task 5: 外部商品数据适配器契约和固定样例映射

**Files:**
- Create: `apps/api/src/collection/providers/commerce-provider.ts`
- Create: `apps/api/src/collection/providers/external/external-commerce.provider.ts`
- Create: `apps/api/src/collection/providers/external/external-commerce.mapper.ts`
- Create: `apps/api/src/collection/providers/external/external-commerce.mapper.spec.ts`
- Create: `apps/api/src/collection/providers/manual/manual-import.provider.ts`
- Create: `tests/fixtures/providers/search-results.json`
- Create: `tests/fixtures/providers/product-bare.json`
- Create: `tests/fixtures/providers/product-bundle.json`
- Create: `tests/fixtures/providers/rate-limited.json`

**Interfaces:**
- Produces: `CommerceProvider.search(query): Promise<SearchHit[]>`
- Produces: `CommerceProvider.fetchOffer(url): Promise<RawOffer>`
- Produces: `RawOffer { platformItemId; shopName; title; skuOptions; listPriceFen; promotions; gifts; stockState; capturedAt; rawEvidence }`
- Throws: `ProviderRateLimitedError`, `ProviderContractChangedError`, `OfferUnavailableError`

- [ ] **Step 1: 写失败契约测试，覆盖关键词搜索、具体 SKU 价格、公开优惠、赠品、库存、限流和字段缺失**
- [ ] **Step 2: 运行适配器测试，确认失败**
- [ ] **Step 3: 实现 provider 接口、供应商结果映射和开发阶段手工导入适配器，禁止适配器直接写数据库**
- [ ] **Step 4: 运行测试，并确认区间最低价不会替代具体 SKU 价格，供应商切换不影响下游模块**
- [ ] **Step 5: 提交 `feat: add replaceable commerce data adapter`**

### Task 6: 搜索候选过滤、型号匹配和商品分类

**Files:**
- Create: `apps/api/src/matching/matcher.service.ts`
- Create: `apps/api/src/matching/matcher.types.ts`
- Create: `apps/api/src/matching/matcher.service.spec.ts`

**Interfaces:**
- Produces: `MatchDecision { category: "BARE" | "BUNDLE" | "REJECTED" | "MANUAL"; comparable: boolean; confidence: number; reasons: string[]; normalizedModel: string | null }`
- Consumes: 标准型号、有效别名、排除别名、必须包含词、排除词和 `RawOffer`

- [ ] **Step 1: 写失败测试，覆盖 Babyface Pro FS 与旧款区分、裸机套装区分、二手/定金/维修排除以及不确定结果进入 MANUAL**
- [ ] **Step 2: 运行 matcher 测试，确认失败**
- [ ] **Step 3: 实现文本规范化、词规则、版本冲突和可解释匹配结果**
- [ ] **Step 4: 运行测试，并验证每个决策至少返回一条可读 reasons**
- [ ] **Step 5: 提交 `feat: classify comparable tmall offers`**

### Task 7: 到手价和套装比较引擎

**Files:**
- Create: `apps/api/src/pricing/price-engine.service.ts`
- Create: `apps/api/src/pricing/bundle-signature.ts`
- Create: `apps/api/src/pricing/price-engine.service.spec.ts`

**Interfaces:**
- Produces: `PriceResult { payableFen: number | null; publicDiscountFen: number; confidence: "CONFIRMED" | "MANUAL"; reasons: string[] }`
- Produces: `bundleSignature(items): string`
- Produces: `bundleReferencePriceFen(payableFen, bundleItems): number`

- [ ] **Step 1: 写失败测试，覆盖页面价、公开券、满减、必付费用、无法确定的私聊价和同配置套装签名**
- [ ] **Step 2: 运行 pricing 测试，确认失败**
- [ ] **Step 3: 实现整数分金额计算、套装签名和折算参考价**
- [ ] **Step 4: 运行测试，确认无浮点误差，且不同配置不被标记为同配置**
- [ ] **Step 5: 提交 `feat: calculate comparable payable prices`**

### Task 8: 采集编排、计划任务和失败恢复

**Files:**
- Create: `apps/api/src/collection/collection.processor.ts`
- Create: `apps/api/src/collection/collection.scheduler.ts`
- Create: `apps/api/src/collection/collection.service.ts`
- Create: `apps/api/src/collection/collection.service.spec.ts`

**Interfaces:**
- Produces: `CollectionService.runMonitoredModel(monitoredModelId, runId): Promise<CollectionSummary>`
- Produces: `CollectionSummary { searched: number; fetched: number; matched: number; failed: number }`
- Consumes: `CHECK_TIMES`, `CommerceProvider`, `MatcherService`, `PriceEngineService`

- [ ] **Step 1: 写失败测试，覆盖 12 个时点入队、同一型号任务锁、单商品失败不终止整批、供应商限流或契约变化触发系统异常**
- [ ] **Step 2: 运行 collection 测试，确认失败**
- [ ] **Step 3: 实现 BullMQ 调度、幂等 runId、供应商限流退避、采集日志和原始证据存储引用**
- [ ] **Step 4: 使用 fake timers 运行测试，确认 Asia/Shanghai 下每天恰好 12 次**
- [ ] **Step 5: 提交 `feat: schedule and orchestrate price collection`**

### Task 9: 预警生成、去重和企业微信通知

**Files:**
- Create: `apps/api/src/alerts/alert.service.ts`
- Create: `apps/api/src/alerts/alert-dedup.ts`
- Create: `apps/api/src/alerts/wecom/wecom.client.ts`
- Create: `apps/api/src/alerts/wecom/wecom.message.ts`
- Create: `apps/api/src/alerts/alert.service.spec.ts`
- Create: `apps/api/src/alerts/wecom/wecom.message.spec.ts`

**Interfaces:**
- Produces: `AlertService.evaluate(ownOffer, competitorOffer, decision): Promise<PriceAlert | null>`
- Produces: `dedupKey(competitorItemId, competitorSkuId, competitorPriceFen): string`
- Produces: `WecomClient.sendPriceAlert(alert): Promise<void>`

- [ ] **Step 1: 写失败测试，覆盖低 1 分即预警、相同价格不预警、同价格不重复、再次降价重发和不同套装配置标为人工核对**
- [ ] **Step 2: 写企业微信消息快照测试，要求包含型号、类型、双方价格、价差、店铺、链接、时间和负责人**
- [ ] **Step 3: 运行测试，确认失败**
- [ ] **Step 4: 实现预警事务、唯一去重索引、企业微信客户端、重试和通知失败记录**
- [ ] **Step 5: 运行 alert 和消息测试，提交 `feat: notify wecom of lower competitor prices`**

### Task 10: 运营处理 API 和预警历史

**Files:**
- Create: `apps/api/src/alerts/alert.controller.ts`
- Create: `apps/api/src/alerts/alert-action.service.ts`
- Create: `apps/api/src/alerts/alert-action.dto.ts`
- Create: `apps/api/src/alerts/alert-action.service.spec.ts`

**Interfaces:**
- Produces: `GET /alerts`, `GET /alerts/:id`, `POST /alerts/:id/actions`
- Action body: `{ status: AlertStatus; reasonCode?: string; note?: string }`
- Rule: `NO_FOLLOW` 和 `FALSE_POSITIVE` 必须提供 reasonCode

- [ ] **Step 1: 写失败测试，覆盖五种状态、必填原因、处理历史和审计记录**
- [ ] **Step 2: 运行 alert action 测试，确认失败**
- [ ] **Step 3: 实现状态机、处理接口、价格历史与证据查询**
- [ ] **Step 4: 运行测试，确认非法状态转换返回 409**
- [ ] **Step 5: 提交 `feat: track operator alert decisions`**

### Task 11: 管理后台核心页面

**Files:**
- Create: `apps/web/src/pages/DashboardPage.tsx`
- Create: `apps/web/src/pages/CatalogPage.tsx`
- Create: `apps/web/src/pages/BareComparisonPage.tsx`
- Create: `apps/web/src/pages/BundleComparisonPage.tsx`
- Create: `apps/web/src/pages/AlertsPage.tsx`
- Create: `apps/web/src/pages/AlertDetailPage.tsx`
- Create: `apps/web/src/pages/SettingsPage.tsx`
- Create: `apps/web/src/features/catalog/ImportDialog.tsx`
- Create: `apps/web/src/features/alerts/AlertActionForm.tsx`
- Test: `apps/web/src/pages/AlertsPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 3、4、9、10 的 REST API
- Produces: 面向运营的导入、比价、预警处理和历史查询界面

- [ ] **Step 1: 写失败组件测试，覆盖裸机套装分栏、低价高亮、Excel 错误行展示和处理原因校验**
- [ ] **Step 2: 运行 web 测试，确认失败**
- [ ] **Step 3: 实现紧凑、可扫描的后台页面，价格列统一右对齐并显示采集时间**
- [ ] **Step 4: 运行组件测试和无障碍检查，确认表格键盘可操作且无文本截断**
- [ ] **Step 5: 提交 `feat: add operator price monitoring console`**

### Task 12: 权限、秘密配置和系统健康检查

**Files:**
- Create: `apps/api/src/auth/roles.guard.ts`
- Create: `apps/api/src/settings/settings.service.ts`
- Create: `apps/api/src/settings/secret-store.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/src/settings/settings.service.spec.ts`
- Create: `docs/operations/security-and-access.md`

**Interfaces:**
- Produces: 角色 `ADMIN`, `OPERATOR`
- Produces: `SecretStore.encrypt`, `SecretStore.decrypt`
- Produces: `GET /health`, `GET /health/collection`

- [ ] **Step 1: 写失败测试，确保运营不能查看 Webhook 明文或修改系统调度**
- [ ] **Step 2: 运行 settings 测试，确认失败**
- [ ] **Step 3: 实现角色守卫、加密秘密存储、脱敏日志和采集健康状态**
- [ ] **Step 4: 运行测试，并用日志扫描确认无 Webhook 或外部数据 API 密钥明文**
- [ ] **Step 5: 提交 `feat: secure monitoring configuration`**

### Task 13: 端到端验收和试运行手册

**Files:**
- Create: `tests/e2e/catalog-to-alert.spec.ts`
- Create: `tests/e2e/duplicate-alert.spec.ts`
- Create: `tests/e2e/manual-bundle-review.spec.ts`
- Create: `docs/operations/operator-guide.md`
- Create: `docs/operations/deployment-guide.md`
- Create: `docs/operations/collector-recovery.md`

**Interfaces:**
- Consumes: 完整应用、测试数据库、Redis、固定天猫 fixture provider 和模拟企业微信端点
- Produces: 可重复执行的验收测试与上线操作说明

- [ ] **Step 1: 写端到端测试：导入 Babyface Pro FS 模板，采集裸机和套装，同行低 1 分时创建一次预警**
- [ ] **Step 2: 写去重测试：同价格重复扫描不重发，降价后新增通知**
- [ ] **Step 3: 写人工套装测试：不同配件配置进入人工核对而非确定低价**
- [ ] **Step 4: 运行 `pnpm test && pnpm test:e2e && pnpm build`，要求全部通过**
- [ ] **Step 5: 完成部署、运营、供应商服务异常和字段契约变化恢复手册，提交 `docs: add rollout and operations guides`**

## Release Gate

- [ ] 20 至 50 个试点型号导入无错误。
- [ ] 裸机与套装分类抽检准确率达到可接受标准，所有不确定结果进入人工分类。
- [ ] 连续 7 天每天 12 次任务均有成功/失败记录，失败不会静默。
- [ ] 低 1 分的可比同行商品能触发企业微信消息。
- [ ] 相同价格不会重复轰炸，再次降价会重新通知。
- [ ] 运营能完成“已改价、不跟价、误报、继续观察”闭环。
- [ ] 企业微信 Webhook 和外部数据 API 密钥不出现在明文日志、Excel 或页面响应中。
