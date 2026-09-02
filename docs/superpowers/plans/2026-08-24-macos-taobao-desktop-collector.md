# macOS Taobao Desktop Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a usable macOS end-to-end price-monitoring path that claims centrally queued model jobs, searches the first 50 Taobao desktop results, captures every valid SKU and public activity price, stores a complete report, and sends one aggregated WeCom alert when competitors are lower than 星空乐器专营店.

**Architecture:** Add a central collector-agent job protocol to the existing NestJS/PostgreSQL service and a separate TypeScript `apps/collector` process for shared workflow, checkpointing, and API communication. Keep macOS UI access behind a native Swift JSON-lines helper using Accessibility APIs; the Node collector converts semantic UI snapshots into the same shared report contract consumed by the API. The API remains responsible for matching, price confidence, persistence, alert deduplication, reporting, scheduling, and WeCom delivery.

**Tech Stack:** Node.js 22+, pnpm 11.19.0, TypeScript 7, Zod 4, NestJS 11, Prisma 7/PostgreSQL 16, BullMQ 6/Redis 7, React 19/Vite, Vitest, Swift 6, macOS Accessibility APIs, Node test runner.

## Global Constraints

- This plan implements the macOS production pilot only; Windows UI Automation and three-machine sharding require a separate plan after the macOS contract is proven.
- The target application bundle identifier is `com.taobao.pcdesktop`; the first compatibility profile is Taobao Desktop `2.4.5` build `15` on macOS 12 or newer.
- A production model run searches exactly the first 50 displayed result positions unless the result page explicitly ends earlier.
- Every enabled SKU combination must be captured or have an explicit incomplete/error record; never substitute the search-list minimum price for a selected SKU price.
- Own-shop and competitor prices use the same formula: activity price minus deterministic, public, single-unit discounts plus mandatory fees.
- Only exact configuration matches with `CONFIRMED` prices may create confirmed-low alerts; a competitor lower by `1` fen must alert.
- Bare products and bundles remain separate comparison pools; uncertain or different bundle configurations go to manual review.
- Do not automate price changes, extract cookies or login tokens, solve challenges, bypass access controls, or add evasion behavior.
- On login loss or a platform challenge, pause the run and require an operator action.
- Use accessibility roles, attributes, labels, and stable item identifiers; do not use hard-coded screen coordinates.
- Store live screenshots, checkpoints, and reports only under ignored `work/collector-runs/`; commit only sanitized fixtures.
- Never print pairing tokens, WeCom Webhooks, account identifiers, cookies, authorization headers, or unredacted live evidence.
- Preserve Node.js 22 and the existing portable test/build commands on macOS, Windows, and Linux; Swift commands are macOS-only and excluded from non-macOS CI jobs.
- The API listens on `127.0.0.1` by default. LAN binding requires an explicit `API_HOST`, encrypted transport through the company-controlled network, and no direct public exposure.

## Delivery Split

This plan is the first independently usable delivery: both Macs can run collectors against one central API, complete a real Sony 7506 run, show every SKU in the report, and notify the operations group. After this plan passes live acceptance, create two separate plans:

1. Windows UI Automation driver plus Windows installer and real-machine acceptance.
2. Three-machine capacity measurement, model sharding, operational hardening, and rollout beyond the pilot model.

## File Map

### Shared contracts and pricing

- `packages/contracts/src/desktop-collector.ts`: runtime schemas and TypeScript types for jobs, positions, SKU observations, issues, reports, and agent messages.
- `packages/contracts/src/desktop-collector.test.ts`: schema and redaction contract tests.
- `packages/contracts/src/index.ts`: public exports.
- `packages/config/src/public-price.ts`: deterministic A+B price calculation.
- `packages/config/src/public-price.test.ts`: price and confidence tests.

### API and persistence

- `prisma/schema.prisma`: collector agents, run assignment/progress, search positions, issues, and SKU price evidence.
- `prisma/migrations/20260824090000_add_desktop_collector/migration.sql`: forward-only database migration.
- `apps/api/src/collector-agent/*`: token hashing, registration, claim, heartbeat, pause, and report submission.
- `apps/api/src/collection/desktop-report-ingestion.service.ts`: transactional report validation and persistence.
- `apps/api/src/collection/run-alert.service.ts`: own baseline selection, per-SKU comparison, alert creation, and one logical run summary.
- `apps/api/src/http/collector-agent-http.controller.ts`: agent-authenticated endpoints.
- `apps/api/src/http/collection-runs-http.controller.ts`: admin run/start/report endpoints.
- `apps/api/src/operations/collection-report-query.service.ts`: report queries for the web app.
- `apps/api/src/runtime.ts`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`: production assembly and lifecycle.

### Collector and macOS helper

- `apps/collector/src/core/*`: driver interface, SKU enumeration, workflow, checkpoints, report writing, and agent loop.
- `apps/collector/src/drivers/fixture/*`: deterministic sanitized driver.
- `apps/collector/src/drivers/macos/*`: Swift-helper client, Taobao selectors, waits, and `TaobaoMacDriver`.
- `apps/collector/src/main.ts`: `diagnose`, `once`, and `worker` CLI commands.
- `apps/collector-macos/Package.swift`: dependency-free Swift executable package.
- `apps/collector-macos/Sources/TaobaoAX/*`: JSON-lines protocol, Accessibility traversal/actions, and screenshot command.
- `apps/collector-macos/Tests/TaobaoAXTests/*`: protocol and pure helper tests.

### Web and operations

- `apps/web/src/pages/CollectionRunsPage.tsx`: run list and completeness status.
- `apps/web/src/pages/CollectionRunDetailPage.tsx`: first-50 positions, all SKU rows, issues, and evidence links.
- `apps/web/src/api/types.ts`, `apps/web/src/app/router.tsx`, `apps/web/src/app/AppShell.tsx`: API types and navigation.
- `docs/operations/macos-collector.md`: permissions, pairing, start, pause, recovery, and pilot verification.
- `README.md`: truthful current capability and startup commands after live acceptance.

---

### Task 1: Add the shared desktop-collector contract

**Files:**
- Create: `packages/contracts/src/desktop-collector.test.ts`
- Create: `packages/contracts/src/desktop-collector.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`

**Interfaces:**
- Produces: `collectorJobSchema`, `collectorReportSchema`, `collectorHeartbeatSchema`, `CollectorJob`, `CollectorReport`, `CollectedItem`, `CollectedSku`, `CollectorIssue`, `PriceConfidence`.
- Produces: schema version `1` with all timestamps represented as ISO-8601 strings and all monetary values represented as non-negative integer fen.
- Consumed by: Tasks 3, 5, 8, 9, 10, and 11.

- [ ] **Step 1: Write the failing contract tests**

Create `packages/contracts/src/desktop-collector.test.ts` with a valid report containing one own SKU and two competitor SKUs, then assert rejection for a missing rank, a negative price, an invalid confidence, and a report containing 51 search positions when `searchLimit` is 50:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { collectorJobSchema, collectorReportSchema } from "./desktop-collector.ts";

const job = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "collector-mac-1",
  monitoredModelId: "model-1",
  searchQuery: "索尼 7506",
  searchLimit: 50,
  ownShopName: "星空乐器专营店",
  ownListings: [{ id: "own-1", url: "https://detail.tmall.com/item.htm?id=own-1", skuText: "7506 单机" }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    effectiveAliases: ["7506"],
    excludedAliases: ["M1", "MV1"],
    mustIncludeTerms: ["7506"],
    excludedTerms: ["二手", "样机", "单独线材"]
  }
} as const;

test("accepts the approved first-50 all-SKU job contract", () => {
  assert.equal(collectorJobSchema.parse(job).searchLimit, 50);
});

test("rejects unsafe money and inconsistent position counts", () => {
  const report = {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "collector-mac-1",
    appVersion: "2.4.5",
    startedAt: "2026-08-24T01:30:00.000Z",
    completedAt: "2026-08-24T01:40:00.000Z",
    status: "SUCCEEDED",
    searchLimit: 50,
    positions: Array.from({ length: 50 }, (_, index) => ({
      rank: index + 1,
      platformItemId: `item-${index + 1}`,
      url: `https://item.taobao.com/item.htm?id=${index + 1}`,
      shopName: `店铺${index + 1}`,
      title: `索尼 7506 商品${index + 1}`,
      displayPriceMinFen: 65_800,
      displayPriceMaxFen: 65_800,
      sponsored: false,
      capturedAt: "2026-08-24T01:30:00.000Z"
    })),
    ownItems: [],
    competitorItems: [],
    issues: []
  };
  assert.equal(collectorReportSchema.parse(report).positions.length, 50);
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    positions: [...report.positions, { ...report.positions[0]!, rank: 51 }]
  }));
  assert.throws(() => collectorReportSchema.parse({
    ...report,
    competitorItems: [{
      platformItemId: "bad",
      url: "https://item.taobao.com/item.htm?id=bad",
      shopName: "同行",
      title: "索尼 7506",
      searchRanks: [1],
      skus: [{
        skuId: "bad-sku",
        label: "7506 单机",
        attributes: {},
        stockState: "IN_STOCK",
        listPriceFen: -1,
        activityPriceFen: 65_800,
        promotions: [],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 65_800,
        capturedAt: "2026-08-24T01:30:00.000Z",
        evidenceKey: null
      }]
    }]
  }));
});
```

- [ ] **Step 2: Run the contract test and verify the expected failure**

Run:

```bash
node --test packages/contracts/src/desktop-collector.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `desktop-collector.ts`.

- [ ] **Step 3: Implement exact Zod schemas and inferred types**

Create `packages/contracts/src/desktop-collector.ts`. Use strict schemas and `.superRefine()` to require unique contiguous ranks, `positions.length <= searchLimit`, unique item/SKU identities, and `completedAt >= startedAt`. Export these constants exactly:

```ts
export const PRICE_CONFIDENCES = ["CONFIRMED", "ESTIMATED", "MANUAL_REVIEW"] as const;
export const COLLECTOR_REPORT_STATUSES = [
  "SUCCEEDED", "PARTIAL_FAILED", "PAUSED_LOGIN", "PAUSED_CHALLENGE", "FAILED"
] as const;
export const COLLECTOR_ISSUE_CODES = [
  "MISSING_ITEM_ID", "ITEM_UNAVAILABLE", "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH", "PRICE_UNSTABLE", "LOGIN_REQUIRED",
  "PLATFORM_CHALLENGE", "APP_VERSION_UNSUPPORTED", "UI_CONTRACT_CHANGED",
  "SCREEN_RECORDING_PERMISSION_REQUIRED", "OWN_BASELINE_MISSING",
  "OWN_BASELINE_AMBIGUOUS"
] as const;
```

Define promotion evidence with `kind`, `label`, `amountFen`, `thresholdFen`, `audience`, `stackGroup`, and `includedInActivityPrice`. Define each SKU with separate list, activity, coupon, full-reduction, direct-discount, mandatory-fee, payable, confidence, and an optional evidence key matching `sha256:<64 lowercase hex characters>`. Every own item carries an `ownListingId`; competitor items must not carry one. Include `collectorId` in the claimed job so the report can repeat the authenticated identity for consistency checking. Use `z.infer` for every public TypeScript type so runtime validation and static types cannot drift.

Add `"zod": "^4.4.3"` to `packages/contracts/package.json` and re-export the module from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run contract and existing package tests**

Run:

```bash
pnpm install --lockfile-only
pnpm test:contracts
```

Expected: all contract tests PASS and `pnpm-lock.yaml` records the package dependency without unrelated upgrades.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat: add desktop collector contracts"
```

---

### Task 2: Persist collector agents, positions, SKU confidence, and issues

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260824090000_add_desktop_collector/migration.sql`
- Create: `apps/api/src/collector-agent/prisma-collector-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma models `CollectorAgent`, `CollectionSearchPosition`, and `CollectionIssue`.
- Extends: `CollectionRun` with assignment, heartbeat, progress, and pause states.
- Extends: `OfferSnapshot` with activity-price components, `PriceConfidence`, an ingestion key, and per-SKU match fields.
- Consumed by: Tasks 3, 9, 10, 11, and 12.

- [ ] **Step 1: Write the failing integration test**

Create an integration test that inserts one enabled macOS agent, assigns one queued run, records ranks `1` and `2`, inserts two SKU snapshots for one candidate, and stores one incomplete-enumeration issue. Assert the unique `(collectionRunId, rank)`, snapshot `ingestionKey`, and issue `issueKey` constraints.

Use these exact fields in the test:

```ts
const agent = await prisma.collectorAgent.create({
  data: {
    name: "mac-studio-1",
    platform: "MACOS",
    tokenHash: "sha256:test-only",
    enabled: true,
    appVersion: "2.4.5"
  }
});

await prisma.collectionSearchPosition.create({
  data: {
    collectionRunId: run.id,
    rank: 1,
    platformItemId: "item-1",
    url: "https://item.taobao.com/item.htm?id=item-1",
    shopName: "同行音频店",
    title: "索尼 7506",
    displayPriceMinFen: 65_800,
    displayPriceMaxFen: 65_800,
    sponsored: false,
    capturedAt: new Date("2026-08-24T01:30:00.000Z")
  }
});
```

- [ ] **Step 2: Verify that the new Prisma API is absent**

Run:

```bash
pnpm db:generate
node --test apps/api/src/collector-agent/prisma-collector-schema.integration.spec.ts
```

Expected: typecheck or test compilation FAIL because `collectorAgent`, `collectionSearchPosition`, and the new snapshot fields do not exist.

- [ ] **Step 3: Extend the Prisma schema**

Add these enums:

```prisma
enum CollectorPlatform {
  MACOS
  WINDOWS
}

enum PriceConfidence {
  CONFIRMED
  ESTIMATED
  MANUAL_REVIEW
}
```

Add `PAUSED_LOGIN`, `PAUSED_CHALLENGE`, and `COALESCED` to `CollectionRunStatus`. Add `CollectorAgent` with `name @unique`, `platform`, `tokenHash @unique`, `enabled`, `appVersion`, `capabilities Json?`, `lastSeenAt`, and timestamps. Add `CollectionSearchPosition` with a unique `(collectionRunId, rank)`, and add `CollectionIssue` with `issueKey @unique`, `code`, optional item/SKU keys, message, `evidenceKey`, and timestamp.

Extend `CollectionRun` with:

```prisma
collectorAgentId String?
claimedAt        DateTime?
heartbeatAt      DateTime?
searchLimit      Int       @default(50)
coalescedIntoRunId String?
discoveredCount Int       @default(0)
skuCount         Int       @default(0)
incompleteCount  Int       @default(0)
collectorAgent   CollectorAgent? @relation(fields: [collectorAgentId], references: [id], onDelete: SetNull)
positions        CollectionSearchPosition[]
issues           CollectionIssue[]
coalescedInto    CollectionRun?  @relation("RunCoalescing", fields: [coalescedIntoRunId], references: [id], onDelete: SetNull)
coalescedRuns    CollectionRun[] @relation("RunCoalescing")
```

Extend `OfferSnapshot` with `activityPriceFen`, `couponDiscountFen`, `fullReductionFen`, `directDiscountFen`, `mandatoryFeeFen`, `priceConfidence @default(MANUAL_REVIEW)`, `evidenceKey String?`, `ingestionKey String? @unique`, `matchDecision CandidateDecision?`, `comparable Boolean @default(false)`, `matchConfidenceBps Int @default(0)`, `normalizedModel String?`, and `matchReasons Json?`. Desktop ingestion computes `ingestionKey` as SHA-256 of run ID, own/candidate identity, item ID, SKU ID, and capture timestamp; legacy provider rows may keep it null.

- [ ] **Step 4: Write the forward-only SQL migration**

Create `prisma/migrations/20260824090000_add_desktop_collector/migration.sql` with PostgreSQL enum creation/alteration, new tables, indexes, foreign keys, and nullable/defaulted columns so existing rows remain valid. Do not drop or rewrite existing price history.

- [ ] **Step 5: Generate, migrate, and run the focused integration test**

Run:

```bash
pnpm db:generate
pnpm db:migrate
node --test apps/api/src/collector-agent/prisma-collector-schema.integration.spec.ts
pnpm db:validate
```

Expected: all commands exit `0`; duplicate rank, ingestion key, and issue key insertions are rejected by PostgreSQL.

- [ ] **Step 6: Commit Task 2**

```bash
git add prisma apps/api/src/collector-agent/prisma-collector-schema.integration.spec.ts
git commit -m "feat: store desktop collection runs"
```

---

### Task 3: Add secure collector registration, claim, heartbeat, and pause APIs

**Files:**
- Create: `apps/api/src/collector-agent/collector-token.ts`
- Create: `apps/api/src/collector-agent/collector-token.spec.ts`
- Create: `apps/api/src/collector-agent/collector-agent.service.ts`
- Create: `apps/api/src/collector-agent/collector-agent.service.spec.ts`
- Create: `apps/api/src/collector-agent/prisma-collector-agent.repository.ts`
- Create: `apps/api/src/http/collector-agent-http.controller.ts`
- Create: `apps/api/src/http/collector-agent-http.controller.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/runtime.ts`

**Interfaces:**
- Produces: `createCollectorToken(): { plaintext: string; hash: string }` and `verifyCollectorToken(plaintext, hash): boolean`.
- Produces: `CollectorAgentService.register`, `claimNext`, `heartbeat`, `pause`, and `assertRunOwnership`.
- Produces HTTP endpoints: `POST /api/collector-agents`, `POST /api/collector-agent/jobs/claim`, `POST /api/collector-agent/jobs/:runId/heartbeat`, and `POST /api/collector-agent/jobs/:runId/pause`.
- Consumes: `CollectorJob` from Task 1 and persistence from Task 2.

- [ ] **Step 1: Write token tests before implementation**

```ts
test("creates a high-entropy token and stores only its hash", () => {
  const token = createCollectorToken();
  assert.match(token.plaintext, /^pmc_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token.plaintext, token.hash);
  assert.equal(verifyCollectorToken(token.plaintext, token.hash), true);
  assert.equal(verifyCollectorToken(`${token.plaintext}x`, token.hash), false);
});
```

Implement tokens as 32 random bytes encoded with `base64url`, prefixed `pmc_`, and store `sha256:<hex>`. Compare equal-length hashes with `timingSafeEqual`. Never log the plaintext.

- [ ] **Step 2: Write service tests for atomic claims and pause behavior**

Use an in-memory repository to verify:

- disabled agents cannot claim;
- two agents cannot claim the same run;
- the claimed job contains one model rule and all active own listings;
- heartbeat updates only the owning agent's run;
- `LOGIN_REQUIRED` maps to `PAUSED_LOGIN` and `PLATFORM_CHALLENGE` maps to `PAUSED_CHALLENGE`;
- a paused run is not claimable until an admin explicitly requeues it.

- [ ] **Step 3: Run focused tests and verify expected failures**

Run:

```bash
node --test apps/api/src/collector-agent/collector-token.spec.ts apps/api/src/collector-agent/collector-agent.service.spec.ts
```

Expected: FAIL because the token and service modules do not exist.

- [ ] **Step 4: Implement the service and Prisma repository**

Use these service signatures exactly:

```ts
export class CollectorAgentService {
  register(input: { name: string; platform: "MACOS" | "WINDOWS" }, actorId: string): Promise<{
    id: string;
    name: string;
    token: string;
  }>;
  claimNext(token: string, input: { appVersion: string; capabilities: string[] }): Promise<CollectorJob | null>;
  heartbeat(token: string, runId: string, input: { discoveredCount: number; skuCount: number }): Promise<void>;
  pause(token: string, runId: string, code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE", message: string): Promise<void>;
  assertRunOwnership(token: string, runId: string): Promise<{ agentId: string; runId: string }>;
}
```

Claim inside a serializable Prisma transaction: select the oldest `QUEUED` run whose `collectorAgentId` is null or already equals the requesting agent, atomically update it to `RUNNING` with agent, claim, heartbeat, and start timestamps, then load the model aliases and active own listings into `collectorJobSchema`. This allows only the same Mac to resume a paused run with its local checkpoint.

- [ ] **Step 5: Add controller authentication and error mapping tests**

Test the controller methods directly with fake requests. Require `Authorization: Bearer <token>` for agent routes. Return `204` when no job exists, `401` for missing/invalid tokens, `409` for wrong run ownership, and `422` for invalid progress or pause input. Mark the admin registration route with `@Roles("ADMIN")`, require the registration request to originate from loopback, and return the plaintext token exactly once. Registration from a non-loopback address returns `403`, preventing the prototype's header-only role marker from enrolling a remote agent.

- [ ] **Step 6: Wire the controller into the existing runtime**

Add `CollectorAgentHttpController` to `AppModule`, instantiate the repository and service in `runtime.ts`, and keep secret values out of Nest startup logs.

- [ ] **Step 7: Run portable API tests**

Run:

```bash
pnpm test:api:portable
pnpm typecheck
```

Expected: all portable API tests and typechecks PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/api/src/collector-agent apps/api/src/http/collector-agent-http.controller.ts apps/api/src/http/collector-agent-http.controller.spec.ts apps/api/src/app.module.ts apps/api/src/runtime.ts
git commit -m "feat: add collector agent job protocol"
```

---

### Task 4: Implement deterministic activity-plus-public-promotion pricing

**Files:**
- Create: `packages/config/src/public-price.test.ts`
- Create: `packages/config/src/public-price.ts`
- Modify: `packages/config/package.json`
- Modify: `apps/api/src/pricing/price-engine.service.ts`
- Modify: `apps/api/src/pricing/price-engine.service.spec.ts`

**Interfaces:**
- Produces: `calculatePublicPrice(input: PublicPriceInput): PublicPriceResult`.
- Produces: separate coupon, full-reduction, direct-discount, mandatory-fee, total-public-discount, payable, confidence, applied labels, and review reasons.
- Consumes: `PromotionEvidence` and `PriceConfidence` from Task 1.
- Replaces: ad hoc subtraction in `PriceEngineService` while preserving its existing public API for manual/external fixtures.

- [ ] **Step 1: Write failing A+B price tests**

Cover these exact cases:

```ts
test("combines the activity price with deterministic single-unit public discounts", () => {
  const result = calculatePublicPrice({
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    promotions: [
      { kind: "COUPON", label: "满600减20", amountFen: 2_000, thresholdFen: 60_000, audience: "PUBLIC", stackGroup: "shop-coupon", includedInActivityPrice: false },
      { kind: "FULL_REDUCTION", label: "满650减10", amountFen: 1_000, thresholdFen: 65_000, audience: "PUBLIC", stackGroup: "platform-full", includedInActivityPrice: false }
    ],
    mandatoryFeeFen: 0
  });
  assert.deepEqual(result, {
    listPriceFen: 77_500,
    activityPriceFen: 65_800,
    couponDiscountFen: 2_000,
    fullReductionFen: 1_000,
    directDiscountFen: 0,
    publicDiscountFen: 3_000,
    mandatoryFeeFen: 0,
    payableFen: 62_800,
    confidence: "CONFIRMED",
    appliedPromotionLabels: ["满600减20", "满650减10"],
    reviewReasons: []
  });
});
```

Also test that a `满700减50` promotion does not apply to `658`, same-group coupons choose the largest eligible amount, `includedInActivityPrice` is not subtracted twice, 88VIP/member promotions are ignored, unknown public amount/threshold/stack group returns `MANUAL_REVIEW`, a page-displayed official estimated payable price returns `ESTIMATED` when promotion details are incomplete, mandatory fees are added, and discounts cannot make the payable price negative.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test packages/config/src/public-price.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public-price.ts`.

- [ ] **Step 3: Implement the pure calculator**

Validate every fen value as a non-negative safe integer. Exclude non-public audiences without reducing confidence. For eligible public promotions, group by non-null `stackGroup`, choose the highest amount inside each group, and sum different groups. If any otherwise relevant public promotion lacks an amount, threshold, or stack group, use `displayedEstimatedPayableFen` with `confidence: "ESTIMATED"` when the page explicitly provides it; otherwise return `payableFen: null` and `confidence: "MANUAL_REVIEW"`. In both cases include the exact uncertain label in `reviewReasons`.

Export `./public-price` from `packages/config/package.json`.

- [ ] **Step 4: Adapt the existing API price engine**

Keep `PriceEngineService.calculate(PriceInput)` working for existing providers by converting each old `publicDiscounts` entry to a unique explicit stack group and mapping `CONFIRMED` or `MANUAL_REVIEW` back to the existing `PriceResult` shape. Add a new `calculateDesktop(input: PublicPriceInput): PublicPriceResult` method for Task 9.

- [ ] **Step 5: Run focused and existing pricing tests**

Run:

```bash
pnpm test:config
node --test apps/api/src/pricing/price-engine.service.spec.ts
pnpm typecheck
```

Expected: all tests PASS; existing manual/external fixtures retain their previous payable prices.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/config apps/api/src/pricing
git commit -m "feat: calculate public activity prices"
```

---

### Task 5: Scaffold the collector app and define the platform-neutral driver

**Files:**
- Create: `apps/collector/package.json`
- Create: `apps/collector/tsconfig.json`
- Create: `apps/collector/src/core/desktop-driver.ts`
- Create: `apps/collector/src/core/sku-enumerator.ts`
- Create: `apps/collector/src/core/sku-enumerator.spec.ts`
- Create: `scripts/run-collector-tests.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `TaobaoDesktopDriver`, `DriverDiagnostic`, `DriverSearchPosition`, `DriverItemPage`, `DriverSkuView`, `SkuSelection`, and typed pause/error classes.
- Produces: `enumerateSkuSelections(dimensions): SkuSelection[]` with deterministic dimension and option order.
- Consumed by: Tasks 6, 9, and 10.

- [ ] **Step 1: Create the failing SKU enumeration tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { enumerateSkuSelections } from "./sku-enumerator.ts";

test("enumerates every enabled combination in page order", () => {
  assert.deepEqual(enumerateSkuSelections([
    { name: "型号", options: [
      { id: "7506", label: "7506", enabled: true },
      { id: "m1", label: "M1", enabled: true }
    ] },
    { name: "套装", options: [
      { id: "bare", label: "单机", enabled: true },
      { id: "cable", label: "C口转换线", enabled: true }
    ] }
  ]), [
    { 型号: "7506", 套装: "单机" },
    { 型号: "7506", 套装: "C口转换线" },
    { 型号: "M1", 套装: "单机" },
    { 型号: "M1", 套装: "C口转换线" }
  ]);
});

test("returns one default selection for a product without dimensions", () => {
  assert.deepEqual(enumerateSkuSelections([]), [{}]);
});

test("does not generate a disabled option", () => {
  const selections = enumerateSkuSelections([{
    name: "规格",
    options: [{ id: "sold-out", label: "售罄", enabled: false }]
  }]);
  assert.deepEqual(selections, []);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test apps/collector/src/core/sku-enumerator.spec.ts
```

Expected: FAIL because the collector app and enumerator do not exist.

- [ ] **Step 3: Create the collector package**

Use this package metadata:

```json
{
  "name": "@stau-price-monitor/collector",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node ../../scripts/run-collector-tests.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@stau-price-monitor/config": "workspace:*",
    "@stau-price-monitor/contracts": "workspace:*",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "tsx": "^4.23.12"
  }
}
```

Extend `../../tsconfig.base.json`, include `src`, and add `test:collector` to the root test chain plus collector typechecking to root `package.json`. Create `scripts/run-collector-tests.mjs` using the same recursive, sorted, no-shell-glob approach as `scripts/run-api-tests.mjs`; resolve `apps/collector/src` relative to the script file so it works from the repository root and package working directory. Fail explicitly when no `.spec.ts` files are found. Do not add a start command until Task 10 supplies a complete CLI.

- [ ] **Step 4: Define the driver contract and typed stop conditions**

Use these exact high-level methods:

```ts
export interface TaobaoDesktopDriver {
  diagnose(): Promise<DriverDiagnostic>;
  openOwnListing(url: string): Promise<DriverItemPage>;
  search(query: string, limit: number): Promise<DriverSearchPosition[]>;
  openSearchPosition(position: DriverSearchPosition): Promise<DriverItemPage>;
  selectSku(selection: SkuSelection): Promise<DriverSkuSelectionResult>;
  returnToSearch(): Promise<void>;
}

export class LoginRequiredError extends Error {}
export class PlatformChallengeError extends Error {}
export class UiContractChangedError extends Error {}
```

Define the selection result as this exact discriminated union:

```ts
export type DriverSkuSelectionResult =
  | { availability: "AVAILABLE"; view: DriverSkuView }
  | { availability: "UNAVAILABLE"; reason: string };
```

`DriverItemPage` must contain item identity, URL, shop, title, ordered SKU dimensions, optional page-reported SKU count, and raw evidence metadata. `DriverSkuView` must contain the confirmed selected labels, raw list/activity/official-estimated-payable price text, structured promotion evidence, mandatory fee text, stock state, timestamp, and an optional local evidence path used only inside the collector process.

- [ ] **Step 5: Implement deterministic enumeration and run tests**

Reject duplicate dimension names or duplicate labels in one dimension with a `TypeError`. Use an iterative Cartesian product; do not impose a combination cap. Dynamic invalid combinations are returned by `selectSku` as `{ availability: "UNAVAILABLE", reason }` in Task 6 rather than being silently dropped.

Run:

```bash
pnpm install --lockfile-only
pnpm test:collector
pnpm typecheck
```

Expected: enumeration tests and all typechecks PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/collector scripts/run-collector-tests.mjs package.json pnpm-lock.yaml
git commit -m "feat: scaffold desktop collector core"
```

---

### Task 6: Build the checkpointed all-SKU workflow with a sanitized fixture driver

**Files:**
- Create: `apps/collector/src/core/checkpoint-store.ts`
- Create: `apps/collector/src/core/checkpoint-store.spec.ts`
- Create: `apps/collector/src/core/collection-runner.ts`
- Create: `apps/collector/src/core/collection-runner.spec.ts`
- Create: `apps/collector/src/drivers/fixture/fixture-driver.ts`
- Create: `apps/collector/test/fixtures/sony-7506.json`

**Interfaces:**
- Produces: `AtomicCheckpointStore.load`, `save`, and `remove`.
- Produces: `CollectionRunner.run(job, collectorId): Promise<CollectorReport>`.
- Produces: `FixtureDriver.fromFile(path)` for deterministic end-to-end tests.
- Consumes: Task 1 report schemas, Task 4 price calculator, and Task 5 driver/enumerator.

- [ ] **Step 1: Write checkpoint atomicity and redaction tests**

Use `mkdtemp` to verify that `save()` writes a valid report-state JSON file through a same-directory temporary file and `rename`, a second save replaces the first, and neither the filename nor serialized content contains a pairing token supplied in unrelated process configuration.

Use this constructor and path layout:

```ts
const store = new AtomicCheckpointStore(rootDirectory);
await store.save("run-1", state);
assert.equal(store.pathFor("run-1"), join(rootDirectory, "run-1", "checkpoint.json"));
```

- [ ] **Step 2: Write a failing fixture workflow test**

Create a sanitized fixture with:

- three search positions;
- positions 1 and 3 pointing to the same item ID;
- one own item from 星空乐器专营店;
- competitor item A containing `7506 单机` at activity price `658.00`, `7506 + C口转换线` at `728.00`, `M1`, and `MV1` SKUs;
- competitor item B containing one out-of-stock 7506 SKU;
- one public coupon that applies to a single unit and one full reduction whose threshold is not met.

Assert that the report keeps all three ranks, opens competitor item A once, records every available SKU separately, computes the applicable discount only, preserves M1/MV1 for later exclusion, and reports the out-of-stock SKU without alert eligibility.

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```bash
node --test apps/collector/src/core/checkpoint-store.spec.ts apps/collector/src/core/collection-runner.spec.ts
```

Expected: FAIL because the checkpoint store and runner do not exist.

- [ ] **Step 4: Implement checkpoint and workflow state**

Persist these checkpoint fields after every completed SKU:

```ts
interface CollectorCheckpoint {
  schemaVersion: 1;
  runId: string;
  jobHash: string;
  phase: "OWN_LISTINGS" | "SEARCH" | "ITEMS" | "COMPLETE";
  completedOwnListingIds: string[];
  completedPlatformItemIds: string[];
  completedSkuKeys: string[];
  report: CollectorReport;
}
```

Hash the canonical validated job with SHA-256. Refuse resume when the job hash differs. For each item, enumerate all base combinations; call `selectSku`; verify the returned selected labels equal the requested selection; calculate A+B pricing; hash each PNG as `sha256:<hex>`, store its local path only in the checkpoint evidence manifest, put only the evidence key in the report, and checkpoint. Add `SKU_SELECTION_MISMATCH`, `PRICE_UNSTABLE`, or `SKU_ENUMERATION_INCOMPLETE` issues instead of manufacturing a price.

Deduplicate detail traversal by stable `platformItemId`, falling back to canonical URL only when an ID is unavailable. Keep every original search rank in `positions`.

- [ ] **Step 5: Add pause and resume tests**

Configure the fixture driver to throw `LoginRequiredError` after the first SKU. Assert the first report status is `PAUSED_LOGIN`; reload the same checkpoint with a healthy fixture driver; assert the completed SKU is not selected twice and the final report becomes `SUCCEEDED`. Repeat for `PlatformChallengeError` and expect `PAUSED_CHALLENGE` without an automatic retry.

- [ ] **Step 6: Run collector tests and typecheck**

Run:

```bash
pnpm test:collector
pnpm typecheck
```

Expected: all collector tests PASS; the sanitized fixture contains no live account, token, webhook, or absolute path.

- [ ] **Step 7: Commit Task 6**

```bash
git add apps/collector/src/core apps/collector/src/drivers/fixture apps/collector/test/fixtures
git commit -m "feat: collect every SKU with checkpoints"
```

---

### Task 7: Create the Swift JSON-lines helper protocol

**Files:**
- Create: `apps/collector-macos/Package.swift`
- Create: `apps/collector-macos/Sources/TaobaoAX/Protocol.swift`
- Create: `apps/collector-macos/Sources/TaobaoAX/Main.swift`
- Create: `apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift`
- Modify: `.gitignore`

**Interfaces:**
- Produces executable: `taobao-ax-helper`.
- Consumes one JSON command per stdin line and emits exactly one JSON response per stdout line.
- Produces commands: `diagnose`, `snapshot`, `perform`, `setValue`, `keyPress`, `captureCopiedText`, and `screenshot`.
- Consumed by: Tasks 8 and 9.

- [ ] **Step 1: Write protocol round-trip tests**

Define Codable messages with these shapes:

```swift
struct HelperCommand: Codable, Equatable {
    let id: String
    let command: CommandName
    let bundleId: String
    let nodePath: [Int]?
    let action: String?
    let value: String?
    let keyCode: Int?
    let destination: String?
}

struct HelperResponse: Codable, Equatable {
    let id: String
    let ok: Bool
    let payload: JSONValue?
    let error: HelperError?
}
```

Test JSON decoding/encoding, unknown commands, missing required fields, response ID preservation, and that protocol output has no extra logging on stdout.

- [ ] **Step 2: Run Swift tests and verify failure**

Run on macOS:

```bash
swift test --package-path apps/collector-macos
```

Expected: FAIL because the Swift package does not exist.

- [ ] **Step 3: Create a dependency-free Swift package**

Set macOS platform minimum to `.v12`, executable product name to `taobao-ax-helper`, and use Foundation only in the protocol target. Implement a `JSONValue` enum covering string, number, boolean, object, array, and null so payloads stay type-safe without third-party packages.

- [ ] **Step 4: Implement the JSON-lines main loop**

Read `stdin` with `readLine()`, decode each command, dispatch through a `CommandHandling` protocol, encode one response, and flush stdout. Send diagnostics only to stderr. Map malformed JSON to `INVALID_REQUEST`, unsupported commands to `UNSUPPORTED_COMMAND`, and unexpected failures to `INTERNAL_ERROR` without including environment values.

- [ ] **Step 5: Ignore native build output and run tests**

Add `apps/collector-macos/.build/` to `.gitignore`.

Run:

```bash
swift test --package-path apps/collector-macos
git status --short
```

Expected: Swift tests PASS and `.build` does not appear in Git status.

- [ ] **Step 6: Commit Task 7**

```bash
git add apps/collector-macos .gitignore
git commit -m "feat: add macOS accessibility helper protocol"
```

---

### Task 8: Implement macOS Accessibility diagnostics, tree snapshots, and actions

**Files:**
- Create: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`
- Create: `apps/collector-macos/Sources/TaobaoAX/AXNode.swift`
- Create: `apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift`
- Create: `apps/collector-macos/Sources/TaobaoAX/ScreenCapture.swift`
- Create: `apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/Main.swift`

**Interfaces:**
- Produces diagnostic payload: trust, app-running state, PID, bundle ID, short version, build, and front-window availability.
- Produces semantic `AXNode` trees with stable child-index paths and selected attributes.
- Produces action execution by path with a fresh-root lookup for every command.
- Consumed by: Task 9.

- [ ] **Step 1: Write pure AX-node serialization tests**

Use value objects, not live UI elements, to verify that a node serializes these keys only:

```swift
struct AXNode: Codable, Equatable {
    let path: [Int]
    let role: String?
    let subrole: String?
    let identifier: String?
    let title: String?
    let description: String?
    let value: JSONValue?
    let url: String?
    let enabled: Bool?
    let selected: Bool?
    let position: AXPoint?
    let size: AXSize?
    let actions: [String]
    let children: [AXNode]
}
```

Assert redaction of text matching `cookie`, `token`, `authorization`, or `webhook` attribute names, a maximum node count, a maximum depth, and deterministic child ordering.

- [ ] **Step 2: Implement application discovery and permission diagnostics**

Use `NSRunningApplication.runningApplications(withBundleIdentifier:)`, `AXUIElementCreateApplication`, `AXIsProcessTrustedWithOptions`, and `Bundle(url:)` to inspect `com.taobao.pcdesktop`. `diagnose` must not prompt unless the command includes an explicit `value: "prompt"`; normal worker startup only reports missing permission.

- [ ] **Step 3: Implement tree serialization**

Read only `AXRole`, `AXSubrole`, `AXIdentifier`, `AXTitle`, `AXDescription`, `AXValue`, `AXURL`, `AXEnabled`, `AXSelected`, `AXPosition`, `AXSize`, `AXActions`, and `AXChildren`. Represent unsupported values as null, guard cycles, and return `TREE_LIMIT_REACHED` rather than truncating silently.

- [ ] **Step 4: Implement semantic actions**

For every `perform` or `setValue`, rebuild the root and resolve the supplied child-index path. Verify the element's current role/title/identifier fingerprint when one is supplied by the Node client. Use `AXUIElementPerformAction`, `AXUIElementSetAttributeValue`, and `CGEvent` only for Return, Page Down, and Home keys while Taobao is frontmost. Do not implement pointer-coordinate clicking.

Implement `captureCopiedText` by snapshotting every `NSPasteboardItem` type and its data, performing the supplied accessible copy-link action, waiting for a changed public UTF-8 string, returning that string, and restoring all prior pasteboard items before responding. Clipboard contents stay in memory and never go to stdout, stderr, checkpoints, or logs.

- [ ] **Step 5: Implement evidence screenshots**

Find the Taobao desktop window bounds with `CGWindowListCopyWindowInfo`, read the allowed evidence root from the helper process's `COLLECTOR_WORK_DIR`, verify the destination resolves inside that canonical root, and write PNG evidence with ScreenCaptureKit or CoreGraphics available on the current macOS SDK. Return `SCREEN_RECORDING_PERMISSION_REQUIRED` when capture permission is absent; never broaden the path to arbitrary filesystem writes.

- [ ] **Step 6: Run Swift tests and a read-only diagnostic**

Run:

```bash
swift test --package-path apps/collector-macos
swift run --package-path apps/collector-macos taobao-ax-helper
```

Send one `diagnose` JSON line for `com.taobao.pcdesktop`. Expected: one valid JSON response showing app version `2.4.5` build `15` when the installed app is unchanged; if accessibility permission is missing, return a typed permission error without crashing.

- [ ] **Step 7: Commit Task 8**

```bash
git add apps/collector-macos
git commit -m "feat: inspect Taobao through macOS accessibility"
```

---

### Task 9: Implement the Taobao 2.4.5 macOS driver and semantic selectors

**Files:**
- Create: `apps/collector/src/drivers/macos/ax-helper-client.ts`
- Create: `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`
- Create: `apps/collector/src/drivers/macos/ax-node.ts`
- Create: `apps/collector/src/drivers/macos/taobao-selectors.ts`
- Create: `apps/collector/src/drivers/macos/taobao-selectors.spec.ts`
- Create: `apps/collector/src/drivers/macos/taobao-price-evidence.ts`
- Create: `apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts`
- Create: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Create: `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`
- Create: `apps/collector/test/fixtures/ax/search-results.json`
- Create: `apps/collector/test/fixtures/ax/item-7506-default.json`
- Create: `apps/collector/test/fixtures/ax/item-7506-cable.json`
- Create: `apps/collector/test/fixtures/ax/login-required.json`
- Create: `apps/collector/test/fixtures/ax/platform-challenge.json`

**Interfaces:**
- Produces: `AxHelperClient` and `TaobaoMacDriver implements TaobaoDesktopDriver`.
- Produces selector functions for search field, result cards, item identity, shop/title, SKU dimensions/options, prices, promotions, stock, login, and challenge states.
- Supports: Taobao Desktop `2.4.5` build `15` only until another fixture profile is reviewed.
- Consumes: Tasks 5, 7, and 8.

- [ ] **Step 1: Capture and sanitize accessibility fixtures**

Use the helper's `snapshot` command on the already installed app for search results for `索尼 7506`, default competitor detail, and the `7506 + C口转换线` selection. Build minimal synthetic login-required and platform-challenge fixtures from their stable visible labels if those pages are not naturally present; mark fixture metadata as `synthetic` and do not intentionally trigger a platform challenge. Replace account names, item IDs, URLs, unrelated shops, and timestamps with deterministic examples while preserving roles, labels, selected states, hierarchy, and price text needed by selectors.

Run the public audit after adding fixtures:

```bash
pnpm audit:public
```

Expected: PASS with no account, token, webhook, cookie, or local absolute path found.

- [ ] **Step 2: Write selector tests before implementation**

Assert all of the following from fixtures:

- the search field is found by role and searchable context, not coordinates;
- exactly ordered search cards are returned with title, shop, price range, and URL/ID when present;
- duplicate result cards preserve separate ranks;
- detail title and shop are read from the correct page region;
- SKU options include `7506 单机`, `7506 + C口转换线`, `M1`, and `MV1`;
- the default SKU exposes activity price `65_800` fen and the cable SKU exposes `72_800` fen;
- login and challenge fixtures throw their typed stop errors before any click action.

- [ ] **Step 3: Run selector tests and verify failure**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts
```

Expected: FAIL because selector modules do not exist.

- [ ] **Step 4: Implement the long-lived helper client**

Spawn the prebuilt helper path from `TAOBAO_AX_HELPER_PATH`, defaulting in development to `apps/collector-macos/.build/debug/taobao-ax-helper`. Assign a UUID to each command, keep a pending promise map, enforce a 15-second command timeout, parse stdout as protocol-only JSON lines, and forward redacted stderr diagnostics. On process exit, reject all pending commands and allow one clean restart before surfacing `UiContractChangedError`.

- [ ] **Step 5: Implement item URL resolution without retaining clipboard contents**

First accept a full `AXURL` containing an `id` query parameter. If only a host is exposed, call the helper's `captureCopiedText` command on the detail page's accessible share/copy-link element, canonicalize the returned item ID, and rely on the helper's full pasteboard restoration. If no stable item ID is available, emit `MISSING_ITEM_ID` and do not claim full completion for that position.

- [ ] **Step 6: Implement price and promotion evidence parsing**

Parse decimal yuan only from labels associated with the selected SKU price region. Recognize these public promotion patterns with strict numeric extraction: `满X减Y`, `X元券`, `立减X元`, and explicit activity-price labels such as `店铺优惠后`. Tag 88VIP, member, account-specific, and personal-red-packet labels with non-public audiences. Set `stackGroup` only when the UI explicitly separates or combines shop coupon, platform full reduction, and direct reduction; otherwise leave it null so Task 4 returns manual review.

- [ ] **Step 7: Implement stable waits and SKU confirmation**

After an action, poll snapshots every 250 ms for at most 15 seconds. Treat the page as stable only after three consecutive observations have the same selected labels, item ID, activity price text, and promotion text. `selectSku` must press each requested label, then verify all selected states. A mismatch returns `SKU_SELECTION_MISMATCH`; changing values through the deadline returns `PRICE_UNSTABLE`.

- [ ] **Step 8: Implement search, detail, and return navigation**

Set and submit the search field, scroll the semantic result container until 50 positions or an explicit end marker, and preserve display order. Open results by accessible link action. Use the app's accessible back action and verify the original query plus result list reappear before continuing. Refuse startup when bundle version/build differs from the approved profile and return `APP_VERSION_UNSUPPORTED` with the observed version.

- [ ] **Step 9: Run all collector tests and the helper tests**

Run:

```bash
pnpm test:collector
swift test --package-path apps/collector-macos
pnpm typecheck
```

Expected: all tests PASS; no selector depends on absolute screen coordinates.

- [ ] **Step 10: Commit Task 9**

```bash
git add apps/collector/src/drivers/macos apps/collector/test/fixtures/ax
git commit -m "feat: automate Taobao desktop on macOS"
```

---

### Task 10: Add the collector worker, secure API client, and report upload

**Files:**
- Create: `apps/collector/src/agent/collector-config.ts`
- Create: `apps/collector/src/agent/collector-config.spec.ts`
- Create: `apps/collector/src/agent/collector-api-client.ts`
- Create: `apps/collector/src/agent/collector-api-client.spec.ts`
- Create: `apps/collector/src/agent/evidence-uploader.ts`
- Create: `apps/collector/src/agent/evidence-uploader.spec.ts`
- Create: `apps/collector/src/agent/collector-worker.ts`
- Create: `apps/collector/src/agent/collector-worker.spec.ts`
- Create: `apps/collector/src/main.ts`
- Create: `.env.collector.example`
- Modify: `apps/collector/package.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/local-env.test.mjs`

**Interfaces:**
- Produces CLI commands: `diagnose`, `once`, and `worker`.
- Consumes environment: `COLLECTOR_API_URL`, `COLLECTOR_PAIRING_TOKEN`, `COLLECTOR_NAME`, `TAOBAO_AX_HELPER_PATH`, and optional `COLLECTOR_WORK_DIR`.
- Calls Task 3 claim/heartbeat/pause endpoints and Task 11 evidence/report endpoints.
- Runs one desktop job at a time and sends a heartbeat every 30 seconds.

- [ ] **Step 1: Write configuration safety tests**

Assert:

- loopback `http://127.0.0.1:4100` and `http://localhost:4100` are accepted;
- non-loopback HTTP URLs are rejected;
- non-loopback HTTPS URLs are accepted;
- pairing token must match `pmc_` plus 43 base64url characters;
- work directory resolves beneath the configured collector root;
- formatting configuration for logs never includes the token.

- [ ] **Step 2: Write API-client tests with a fake fetch**

Verify Bearer authentication, validated claim response, `204` as no job, heartbeat payloads, evidence upload, report upload, typed `401/409/413/422/503` errors, timeout cancellation, and that thrown errors redact the Authorization header and request body.

- [ ] **Step 3: Write worker lifecycle tests**

Use fake API and driver instances to verify:

- `once` claims one job, runs it, uploads one validated report, then exits;
- `worker` waits 30 seconds after a `204` without busy-looping;
- heartbeat starts after claim and stops before upload returns;
- login/challenge reports call `pause` and do not upload a successful report;
- transient evidence or report upload failure retries three times with bounded exponential delays while retaining the checkpoint;
- a successful upload removes the checkpoint only after the API acknowledges it.

- [ ] **Step 4: Run focused tests and verify failures**

Run:

```bash
node --test apps/collector/src/agent/*.spec.ts
```

Expected: FAIL because the agent modules do not exist.

- [ ] **Step 5: Implement configuration, API client, and worker**

Use `AbortSignal.timeout(15_000)` for API calls. Send heartbeats every 30 seconds with discovered-position and completed-SKU counts. Use `AtomicCheckpointStore` under `work/collector-runs/<runId>`. Before submitting a report, upload each unique PNG from the checkpoint evidence manifest as multipart form data keyed by its SHA-256; mark an evidence key uploaded only after the API confirms the same hash. Emit only structured logs containing run ID, phase, counts, and redacted error code.

- [ ] **Step 6: Implement the CLI**

Use these commands:

```text
collector diagnose
collector once
collector worker
```

`diagnose` checks platform, helper executable, Accessibility permission, Taobao app version/running/login state, API reachability, and pairing without claiming a job. `once` claims at most one job. `worker` continues until SIGINT/SIGTERM, then stops claiming, completes or safely checkpoints the active SKU, stops heartbeat, and exits.

Add package `start` as `node --env-file=../../.env.collector --import=tsx src/main.ts`, root scripts `collector:diagnose`, `collector:once`, `collector:worker`, and collector checks to `pnpm run doctor` only on macOS. Create `.env.collector.example` with blank token plus loopback API URL, collector name, work directory, and helper path. Add `!.env.collector.example` to `.gitignore` while keeping the real `.env.collector` ignored. Do not require Swift on Windows/Linux portable checks.

- [ ] **Step 7: Run collector and portable verification**

Run:

```bash
pnpm test:collector
pnpm verify:portable
```

Expected: PASS on macOS; portable verification does not attempt to launch Taobao or compile Swift.

- [ ] **Step 8: Commit Task 10**

```bash
git add apps/collector .env.collector.example .gitignore package.json scripts pnpm-lock.yaml
git commit -m "feat: run the macOS collector agent"
```

---

### Task 11: Ingest complete desktop reports transactionally

**Files:**
- Create: `apps/api/src/collection/desktop-report-ingestion.service.ts`
- Create: `apps/api/src/collection/desktop-report-ingestion.service.spec.ts`
- Create: `apps/api/src/collection/prisma-desktop-report.repository.ts`
- Create: `apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts`
- Create: `apps/api/src/collection/collection-evidence-store.ts`
- Create: `apps/api/src/collection/collection-evidence-store.spec.ts`
- Modify: `apps/api/src/http/collector-agent-http.controller.ts`
- Modify: `apps/api/src/http/collector-agent-http.controller.spec.ts`
- Modify: `apps/api/src/runtime.ts`

**Interfaces:**
- Produces: `DesktopReportIngestionService.ingest(agentToken, report): Promise<IngestionSummary>`.
- Produces: `IngestionSummary` with run status, position count, unique item count, SKU count, issue count, own snapshot IDs, and competitor snapshot IDs.
- Adds endpoints: `PUT /api/collector-agent/jobs/:runId/evidence/:sha256` and `POST /api/collector-agent/jobs/:runId/report`.
- Consumes: Task 1 report schema, Task 2 database fields, and Task 3 run ownership.

- [ ] **Step 1: Write unit tests for validation and ownership**

Assert rejection when the path run ID differs from the report, report collector ID differs from the authenticated agent, rank count exceeds the job limit, item URL and ID disagree, completed time precedes started time, or a supposedly successful report contains an incomplete-enumeration issue.

Assert that `PAUSED_LOGIN` and `PAUSED_CHALLENGE` reports cannot be submitted as successful completion; those states must use the pause endpoint.

- [ ] **Step 2: Write the transactional integration test**

Seed one model, one own listing, one assigned run, and a validated report with 50 positions, duplicate ranks for one item, two own SKUs, and four competitor SKUs. Ingest twice. Assert:

- 50 `CollectionSearchPosition` rows, not 100;
- every unique SKU has one `OfferSnapshot`;
- own snapshots link to `OwnListing` and competitors link to `SearchCandidate`;
- price component, confidence, and evidence-key columns exactly match the report;
- issues are idempotent;
- run counters and final status match the stored rows;
- the second submission returns the original summary without duplicate history.

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```bash
node --test apps/api/src/collection/desktop-report-ingestion.service.spec.ts
node --test apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts
```

Expected: FAIL because ingestion modules and the report endpoint do not exist.

- [ ] **Step 4: Implement transactional persistence**

Validate at the HTTP boundary with `collectorReportSchema`. Resolve each own item through its `ownListingId` from the claimed job; never identify ownership from a user-editable shop string alone. Upsert candidates by `(monitoredModelId, providerKey, platformItemId)`, positions by `(collectionRunId, rank)`, and snapshots by the Task 2 idempotency key. Store raw evidence as redacted JSON and only store validated evidence keys in database rows.

Set candidate-level decision to `PENDING` during ingestion; Task 12 computes each SKU decision. Finish the run only after all rows commit. On transaction failure, keep the run `RUNNING`, store a system error, and allow the same report to retry.

- [ ] **Step 5: Implement the content-addressed evidence store**

Store evidence beneath `work/collector-evidence/<runId>/<sha256>.png`. Accept one PNG no larger than 2 MiB, verify the PNG signature, recompute SHA-256, require it to equal the path hash, and write through a temporary file plus atomic rename. Reject path separators, uppercase/non-hex hashes, hash mismatches, non-PNG input, and a run not owned by the authenticated agent. Re-uploading identical content returns success without rewriting it.

- [ ] **Step 6: Add authenticated evidence and report endpoints**

Use Multer memory storage with a one-file, 2 MiB limit for evidence. Return `201` for a new evidence object and `200` for an idempotent repeat. Before report ingestion, require every non-null report evidence key to exist for the run. Return `202` with `IngestionSummary` for a newly accepted report and `200` for an idempotent repeat. Return `401` for invalid token, `409` for wrong owner or non-running state, `413` when the evidence or configured JSON body limit is exceeded, and `422` for hash/contract validation errors without echoing the report body.

- [ ] **Step 7: Run portable and integration tests**

Run:

```bash
pnpm test:api:portable
pnpm test:api
pnpm typecheck
```

Expected: all tests PASS with PostgreSQL and Redis available for the full suite.

- [ ] **Step 8: Commit Task 11**

```bash
git add apps/api/src/collection apps/api/src/http/collector-agent-http.controller.ts apps/api/src/http/collector-agent-http.controller.spec.ts apps/api/src/runtime.ts
git commit -m "feat: ingest desktop SKU reports"
```

---

### Task 12: Compare every SKU and send one model-level WeCom summary

**Files:**
- Create: `apps/api/src/collection/run-alert.service.ts`
- Create: `apps/api/src/collection/run-alert.service.spec.ts`
- Create: `apps/api/src/alerts/run-alert-notifier.ts`
- Create: `apps/api/src/alerts/run-alert-notifier.spec.ts`
- Create: `apps/api/src/alerts/wecom/wecom-run-summary.ts`
- Create: `apps/api/src/alerts/wecom/wecom-run-summary.spec.ts`
- Modify: `apps/api/src/alerts/wecom/wecom.client.ts`
- Create: `apps/api/src/alerts/wecom/wecom.client.spec.ts`
- Modify: `apps/api/src/alerts/alert-dedup.ts`
- Modify: `apps/api/src/alerts/alert.service.ts`
- Modify: `apps/api/src/alerts/alert.service.spec.ts`
- Modify: `apps/api/src/matching/matcher.service.ts`
- Modify: `apps/api/src/matching/matcher.service.spec.ts`
- Modify: `apps/api/src/collection/desktop-report-ingestion.service.ts`
- Modify: `apps/api/src/runtime.ts`

**Interfaces:**
- Produces: `RunAlertService.evaluateRun(runId): Promise<RunAlertSummary>`.
- Produces: `RunAlertNotifier.send(summary): Promise<void>` with at most one WeCom request per model run.
- Extends per-SKU snapshot decisions and alert deduplication.
- Consumes confirmed prices and all snapshots persisted by Task 11.

- [ ] **Step 1: Add failing SKU-match regression tests**

Add cases where a product title contains `索尼 7506` but the selected SKU is `M1`, `MV1`, `展示样机`, or `单独转换线`; all must be rejected when those terms are in the rule. Verify `7506 单机` is exact bare and `7506 + C口转换线` is a bundle/review candidate rather than the same bare configuration. Add version tests so an explicitly configured version must appear in the title or selected SKU.

- [ ] **Step 2: Add failing run-comparison tests**

Use snapshots with own confirmed price `69_800` fen and competitor prices `69_800`, `69_799`, `65_800`, manual-review price `60_000`, out-of-stock price `50_000`, and M1 price `40_000`. Assert only `69_799` and `65_800` create confirmed-low records; equality, uncertain price, out-of-stock, and wrong model do not.

For bundles, assert exact accessory signatures may compare while different signatures create a manual-review event only.

- [ ] **Step 3: Change alert creation to persist first and notify after the run**

Remove immediate notification from `AlertService`: `evaluate` validates and persists one new alert, while `RunAlertNotifier` owns grouped delivery and notification bookkeeping. Extend `AlertRepository` with `markBatchNotified(ids, notifiedAt)` and `recordBatchNotificationFailure(ids, message)`. After all SKU pairs are evaluated, pass only newly created alerts to one `RunAlertNotifier`. Change the dedup key to include monitored model, own SKU ID, competitor item ID, competitor SKU ID, and competitor payable price.

- [ ] **Step 4: Persist per-SKU match decisions**

For each competitor snapshot, reconstruct a one-selected-SKU `RawOffer`, call `MatcherService`, and save decision, comparable flag, confidence basis points, normalized model, and reasons on that snapshot. Derive candidate-level decision from its snapshots: exact if any exact SKU exists, manual if no exact but a review SKU exists, otherwise rejected.

- [ ] **Step 5: Select the authoritative own baseline**

Normalize each configured `OwnListing.skuText` and match it against own snapshot labels/attributes. Require exactly one in-stock `CONFIRMED` match per comparison rule. If zero or multiple matches exist, create `OWN_BASELINE_MISSING` or `OWN_BASELINE_AMBIGUOUS` collection issues and send a system summary without competitor low-price conclusions.

- [ ] **Step 6: Build one bounded WeCom message**

Refactor `WecomClient` to expose `sendMarkdown(message)` while retaining strict official-host URL validation, timeout, and retry behavior. Format one logical model summary containing model, comparison type, completion ratio, own SKU/activity/public-discount/payable prices, and each new low competitor's rank, shop, SKU, activity price, discount, payable price, difference, and link. Keep message content below 3,500 Unicode characters. When details exceed the limit, include total low-SKU count, the five largest differences, issue count, and the full report URL; do not send continuation messages.

- [ ] **Step 7: Test notification failure and idempotency**

Assert alerts remain stored when WeCom fails, the run records one notification failure, retry sends the same logical summary once, and a repeated identical run creates no new alert or WeCom message. A further competitor price drop must create a new alert and one new summary.

- [ ] **Step 8: Run focused and portable tests**

Run:

```bash
node --test apps/api/src/matching/matcher.service.spec.ts apps/api/src/collection/run-alert.service.spec.ts apps/api/src/alerts/run-alert-notifier.spec.ts apps/api/src/alerts/wecom/wecom-run-summary.spec.ts
pnpm test:api:portable
pnpm typecheck
```

Expected: all tests PASS; no test sends a real network request.

- [ ] **Step 9: Commit Task 12**

```bash
git add apps/api/src/alerts apps/api/src/collection apps/api/src/matching apps/api/src/runtime.ts
git commit -m "feat: alert on lower desktop SKU prices"
```

---

### Task 13: Assemble scheduling, manual runs, WeCom, and API lifecycle

**Files:**
- Create: `apps/api/src/collection/collection-run-queue.service.ts`
- Create: `apps/api/src/collection/collection-run-queue.service.spec.ts`
- Create: `apps/api/src/http/collection-runs-http.controller.ts`
- Create: `apps/api/src/http/collection-runs-http.controller.spec.ts`
- Create: `apps/api/src/runtime.spec.ts`
- Modify: `apps/api/src/collection/collection.processor.ts`
- Modify: `apps/api/src/collection/collection.scheduler.ts`
- Modify: `apps/api/src/runtime.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/health/health.service.ts`
- Modify: `apps/api/src/health/health.service.spec.ts`
- Modify: `apps/api/src/settings/settings.service.ts`
- Modify: `apps/api/src/settings/settings.service.spec.ts`
- Modify: `apps/api/src/http/settings-http.controller.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `CollectionRunQueueService.enqueueEnabledModels(scheduledFor)` and `enqueueModelNow(modelId, actorId)`.
- Adds admin endpoints: `POST /api/collection-runs` with `{ monitoredModelId, searchLimit? }` and `POST /api/collection-runs/:runId/requeue`.
- Registers the existing 12 Asia/Shanghai schedules and creates one queued run per enabled model per slot.
- Assembles WeCom only when an encrypted Webhook is configured.
- Uses `PUBLIC_BASE_URL` to build report links included in WeCom messages.
- Adds `desktop` to the configured commerce-provider union and uses provider key `taobao-desktop` for these runs.

- [ ] **Step 1: Write queue-service tests**

Verify that one schedule event creates one `QUEUED` run per enabled model, disabled models are skipped, the unique `(monitoredModelId, providerKey, scheduledFor)` constraint makes duplicate schedule delivery idempotent, and an existing unfinished run for the same model creates a new `COALESCED` slot record linked by `coalescedIntoRunId` rather than concurrent work.

- [ ] **Step 2: Write manual-run controller tests**

Require `ADMIN`, require the selected provider to be `desktop`, reject unknown or disabled models, accept an integer `searchLimit` from `1` through `50` for supervised smoke runs, default to `50`, return `202` with run ID for a new request, and return the existing run ID plus `coalesced: true` when work is already queued/running. Scheduled runs always use `50`. Do not let an operator header bypass the role guard.

Test requeue separately: only `PAUSED_LOGIN` and `PAUSED_CHALLENGE` may return to `QUEUED`; preserve the assigned collector so the same Mac can resume its checkpoint, clear pause error fields, and reject requeue for running, completed, failed, or coalesced runs.

- [ ] **Step 3: Write runtime assembly tests with fakes**

Verify startup registers all 12 schedules only when schedule settings are enabled, starts one BullMQ schedule worker, exposes queued-run and collector-agent health, uses the decrypted WeCom Webhook only inside the notifier factory, and closes worker/queue/Redis/Prisma in order on shutdown.

Add settings tests proving `desktop` can be saved/read, the default remains `manual` for fresh development databases, and automatic desktop runs are not enqueued while another provider is selected.

- [ ] **Step 4: Implement queueing and schedule worker**

Keep BullMQ responsible only for the 12 clock events. The schedule worker calls `enqueueEnabledModels`; desktop agents claim database runs through Task 3. Set queue attempts to one because database enqueue is idempotent and platform retries happen at the collector layer.

- [ ] **Step 5: Assemble WeCom safely**

On run completion, call `settingsService.readSecretForInternalUse("WECOM_WEBHOOK")`. If absent, retain alerts with a `WECOM_NOT_CONFIGURED` notification error and do not fail the collection report. If present, instantiate `WecomClient` for that send, then discard the plaintext reference. Existing URL validation and retry behavior remain active.

- [ ] **Step 6: Make API binding explicit**

Change `app.listen(port, "127.0.0.1")` to `app.listen(port, process.env.API_HOST ?? "127.0.0.1")`. Reject `API_HOST=0.0.0.0` in production unless `ALLOW_PRIVATE_NETWORK_API=true`; document that LAN deployment must be protected by the company network and TLS proxy. Disable Nest's default body parser, install Express JSON parsing with a default 8 MiB limit from `COLLECTOR_REPORT_JSON_LIMIT`, and keep the evidence route on Multer's independent 2 MiB file limit. Require an absolute HTTP(S) `PUBLIC_BASE_URL` before sending report links, and prefer HTTPS for non-loopback values. Add all new non-secret keys to `.env.example` and test invalid/oversized limit and URL configuration.

- [ ] **Step 7: Run scheduler, API, and complete automated tests**

Run:

```bash
pnpm test:api:portable
pnpm test:api
pnpm test:e2e
pnpm typecheck
```

Expected: all tests PASS; no real schedule, Taobao action, or WeCom message occurs in tests.

- [ ] **Step 8: Commit Task 13**

```bash
git add apps/api/src/collection apps/api/src/http/collection-runs-http.controller.ts apps/api/src/http/collection-runs-http.controller.spec.ts apps/api/src/http/settings-http.controller.ts apps/api/src/settings apps/api/src/runtime.ts apps/api/src/runtime.spec.ts apps/api/src/main.ts apps/api/src/app.module.ts apps/api/src/health .env.example
git commit -m "feat: schedule desktop collection runs"
```

---

### Task 14: Add complete-run reporting, operator documentation, and live Mac acceptance

**Files:**
- Create: `apps/api/src/operations/collection-report-query.service.ts`
- Create: `apps/api/src/operations/collection-report-query.service.spec.ts`
- Create: `apps/api/src/http/collection-evidence-http.controller.ts`
- Create: `apps/api/src/http/collection-evidence-http.controller.spec.ts`
- Modify: `apps/api/src/http/operations-http.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/runtime.ts`
- Create: `apps/web/src/pages/CollectionRunsPage.tsx`
- Create: `apps/web/src/pages/CollectionRunsPage.test.tsx`
- Create: `apps/web/src/pages/CollectionRunDetailPage.tsx`
- Create: `apps/web/src/pages/CollectionRunDetailPage.test.tsx`
- Create: `apps/web/src/pages/SettingsPage.test.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/src/app/AppShell.tsx`
- Modify: `apps/web/src/app/AppShell.test.tsx`
- Create: `docs/operations/macos-collector.md`
- Modify: `docs/operations/macos-setup.md`
- Modify: `docs/operations/collector-recovery.md`
- Modify: `README.md`

**Interfaces:**
- Adds API endpoints: `GET /api/operations/collection-runs` and `GET /api/operations/collection-runs/:runId`.
- Adds evidence endpoint: `GET /api/operations/collection-runs/:runId/evidence/:sha256`.
- Adds web routes: `/runs` and `/runs/:runId`.
- Displays search completeness, every SKU, price components/confidence, matching decision, issues, and evidence.

- [ ] **Step 1: Write report-query service tests**

Assert the list response includes run status, model, collector, scheduled/start/finish times, positions found versus limit, unique items, SKU count, incomplete count, and notification state. Assert detail positions are rank ordered and SKU rows can be filtered by own/competitor, exact/review/excluded, lower/not-lower, and confidence.

- [ ] **Step 2: Write page tests before implementation**

Use API fixtures to verify:

- `47 / 50` is visibly incomplete rather than green success;
- all SKU rows render independently, including same-price SKUs;
- activity price, coupon, full reduction, payable price, stock, rank, match decision, and evidence link have separate columns;
- paused login/challenge states show the required operator action;
- an administrator can requeue a paused run after manually resolving the Taobao page, while other statuses do not show the action;
- mobile tables scroll without controls overlapping;
- the global “开发原型不会自动采集” banner is replaced with truthful collector health text only when the API reports the assembled runtime.
- the settings page offers “淘宝桌面版采集器” as `desktop`, labels automatic checks as active functionality, and keeps the external API key field separate;

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```bash
node --test apps/api/src/operations/collection-report-query.service.spec.ts apps/api/src/http/collection-evidence-http.controller.spec.ts
pnpm --filter @stau-price-monitor/web exec vitest run src/pages/CollectionRunsPage.test.tsx src/pages/CollectionRunDetailPage.test.tsx src/pages/SettingsPage.test.tsx src/app/AppShell.test.tsx
```

Expected: FAIL because the report service and pages do not exist.

- [ ] **Step 4: Implement APIs and pages**

Use the existing unframed panel/table visual language. Add one “采集任务” navigation item with a familiar history/database icon. Keep desktop tables dense and scannable; on narrow screens preserve columns through horizontal scrolling rather than shrinking text below readable size. The evidence controller must first verify that the requested hash belongs to a snapshot or issue in the requested run, then resolve it through `CollectionEvidenceStore`, return `image/png` with `Cache-Control: private, no-store`, and reject every path-like or unreferenced value. Never expose raw filesystem paths.

- [ ] **Step 5: Write the macOS operator guide**

Document exact steps for:

1. granting Accessibility and Screen Recording permissions;
2. registering each Mac collector and storing the one-time token in a local ignored env file;
3. running `pnpm collector:diagnose`;
4. starting `pnpm collector:worker`;
5. keeping Taobao logged in and the screen unlocked;
6. pausing for login/challenge and resuming after manual resolution;
7. locating the full 50-position/all-SKU report;
8. revoking a lost or retired collector;
9. confirming that no automated price changes occur.

- [ ] **Step 6: Run automated verification before live actions**

Run:

```bash
pnpm audit:public
pnpm verify
swift test --package-path apps/collector-macos
pnpm run doctor
```

Expected: all commands PASS. Do not proceed to live Taobao actions if public audit, database tests, or contract tests fail.

- [ ] **Step 7: Perform a three-result supervised smoke run**

With the user present, verify one enabled pilot rule exists with brand `Sony`, standard model `MDR-7506`, effective alias `7506`, bare comparison type, exclusions for `M1`, `MV1`, `样机`, `二手`, and accessory-only links, plus the operator-confirmed 星空乐器专营店 item URL and target bare-SKU text. Run diagnostics, manually enqueue only this model, and run the collector with a temporary admin smoke limit of `3`. Verify the app search query, three ranks, item IDs/links, every enabled SKU on those items, activity-price switching, checkpoint cleanup, report rendering, and no challenge. Stop immediately on login loss or platform verification.

- [ ] **Step 8: Perform the first-50 supervised acceptance run**

Restore the job limit to `50` and run once. Acceptance requires either 50 ordered positions or an explicit page-end count, every unique item visited once, every valid SKU captured or an explicit issue, own baseline identified, M1/MV1/accessory/sample SKUs excluded from exact 7506 bare comparison, and low-price calculations manually spot-checked at ranks 1, 13, 25, 37, and the final rank.

Keep the live report under ignored `work/collector-runs/`; do not commit live prices, shop lists, screenshots, or account data.

- [ ] **Step 9: Send one approved WeCom pilot message**

Before the first real Webhook send, obtain the user's confirmation at action time. Then trigger one run summary and verify the operations group receives one logical model message with the full report link. Confirm duplicate submission sends no second message and a fixture-only further price drop sends exactly one new test summary without modifying any Taobao price.

- [ ] **Step 10: Verify the rendered UI on desktop and mobile**

Start API and web development servers, use the Browser plugin to inspect `/runs` and one detail page at desktop and mobile widths, and capture screenshots. Confirm no clipped controls, overlapping tables, broken links, console errors, or misleading complete status. Keep screenshots in ignored work output unless they are sanitized before documentation use.

- [ ] **Step 11: Update truthful status documentation**

Only after the live 50-result acceptance succeeds, update README and recovery wording from “no automatic collector is assembled” to the exact macOS pilot capability. State plainly that Windows and multi-machine production sharding are not yet accepted.

- [ ] **Step 12: Run final verification and commit Task 14**

Run:

```bash
pnpm audit:public
pnpm verify
swift test --package-path apps/collector-macos
git status --short
```

Expected: tests and audits PASS; Git status contains only intended source/documentation changes and no live evidence.

```bash
git add apps/api/src/operations apps/api/src/http/operations-http.controller.ts apps/api/src/http/collection-evidence-http.controller.ts apps/api/src/http/collection-evidence-http.controller.spec.ts apps/api/src/app.module.ts apps/api/src/runtime.ts apps/web/src docs/operations README.md
git commit -m "feat: deliver macOS Taobao collector pilot"
```

---

## Completion Gate

Do not call this plan complete until all of the following are true:

- One Sony 7506 run has 50 ordered positions or an explicit earlier page end.
- Every accessible product has all valid SKU combinations recorded or a specific incomplete/error code.
- Own and competitor A+B prices have the same calculation evidence and confidence rules.
- M1, MV1, display sample, accessory-only, and mismatched bundle SKUs cannot trigger a confirmed 7506 bare alert.
- A competitor lower by 1 fen creates one alert; equal/higher, uncertain, and out-of-stock prices do not.
- The operations group receives at most one logical WeCom message for the model run.
- The report UI shows completion ratio, every SKU, all price components, decision, issue, and evidence.
- Login/challenge states pause without bypass behavior.
- `pnpm audit:public`, `pnpm verify`, and `swift test --package-path apps/collector-macos` pass.
- Live evidence and secrets remain untracked.

## Follow-Up Plans

After this completion gate, write and approve:

- `2026-08-24-windows-taobao-desktop-driver.md`: Windows UI Automation driver, installer, diagnostics, and real Windows acceptance against the same contracts.
- `2026-08-24-collector-fleet-sharding.md`: three-machine registration, throughput measurement, model assignment, queue capacity, TLS/private-network deployment, and production rollout.
