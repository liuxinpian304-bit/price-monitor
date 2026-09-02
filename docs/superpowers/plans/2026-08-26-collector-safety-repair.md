# Collector Safety Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent uncertain public promotions from producing confirmed low-price alerts and guarantee that every committed run alert has a durable, restartable WeCom notification batch.

**Architecture:** Normalize legacy promotion evidence conservatively at the contract boundary, migrate saved checkpoints before strict parsing, and keep the shared price calculator tri-state-only. Extend the existing run-alert database transaction so it writes the immutable notification batch beside new alerts; the sender will only claim already-persisted batches.

**Tech Stack:** TypeScript, Node.js test runner, Zod, Prisma 7, PostgreSQL, React/Vite regression suite, Swift Package Manager build gate.

## Global Constraints

- A missing `activityPriceInclusion` plus legacy `includedInActivityPrice: false` means `UNKNOWN`, never `EXCLUDED`.
- Only explicit `activityPriceInclusion: "EXCLUDED"` may cause a public promotion to be subtracted from the activity price.
- Any applicable public promotion with `UNKNOWN` inclusion prevents `priceConfidence: "CONFIRMED"`.
- Legacy checkpoints retain rankings, SKU evidence, completion lists, and progress; affected prices become `MANUAL_REVIEW` or `ESTIMATED`.
- Legacy checkpoint migration is idempotent.
- Price alerts and `RunAlertNotificationBatch` are committed in the same PostgreSQL transaction.
- Reuse the existing `RunAlertNotificationBatch` table and its unique `collectionRunId`; do not add a second outbox table.
- The sender claims only pre-existing durable batches and never reconstructs an absent batch after evaluation commit.
- An abandoned or response-lost WeCom `SENDING` attempt remains `AMBIGUOUS` and is not automatically posted again.
- Do not change the operator UI in this repair.
- Do not access a real Taobao account or send a real WeCom message during implementation or automated verification.
- Keep portable TypeScript paths and process execution compatible with macOS and Windows.
- Use test-driven development: observe every new regression test fail before modifying production code.
- Use an isolated PostgreSQL schema for database tests; never run integration tests against `public`.

---

### Task 1: Make Promotion Inclusion Conservative at Every Report Boundary

**Files:**
- Modify: `packages/contracts/src/desktop-collector.ts`
- Modify: `packages/contracts/src/desktop-collector.test.ts`
- Modify: `packages/config/src/public-price.ts`
- Modify: `packages/config/src/public-price.test.ts`
- Modify: `apps/api/src/pricing/price-engine.service.ts`
- Modify: `apps/api/src/pricing/price-engine.service.spec.ts`
- Modify fixtures only where deterministic exclusion is intended: `apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts`
- Verify existing explicit tri-state behavior: `apps/collector/src/drivers/macos/taobao-price-evidence.ts`
- Verify existing parser tests: `apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts`

**Interfaces:**
- Produces: `PromotionEvidence.activityPriceInclusion: "INCLUDED" | "EXCLUDED" | "UNKNOWN"` as a required parsed output field.
- Produces: legacy input normalization where old `true` becomes `INCLUDED` and old `false` becomes `UNKNOWN`.
- Produces: report rejection when `priceConfidence === "CONFIRMED"` and any public promotion has `activityPriceInclusion === "UNKNOWN"`.
- Consumes: the existing `CollectorReport`, `PublicPriceInput`, and `PublicPriceResult` shapes.

- [ ] **Step 1: Add failing contract tests for legacy normalization and confirmed-price rejection**

Update the normal accepted fixture so deterministic discounts are explicit:

```ts
activityPriceInclusion: "EXCLUDED" as const
```

Then add tests with these assertions:

```ts
test("normalizes legacy false inclusion to UNKNOWN and never accepts it as confirmed", () => {
  const legacyManual = structuredClone(report) as any;
  const legacySku = legacyManual.competitorItems[0].skus[0];
  delete legacySku.promotions[0].activityPriceInclusion;
  legacySku.promotions[0].includedInActivityPrice = false;
  legacySku.couponDiscountFen = 0;
  legacySku.fullReductionFen = 0;
  legacySku.directDiscountFen = 0;
  legacySku.priceConfidence = "MANUAL_REVIEW";
  legacySku.payableFen = null;

  const parsed = collectorReportSchema.parse(legacyManual);
  assert.equal(
    parsed.competitorItems[0]?.skus[0]?.promotions[0]?.activityPriceInclusion,
    "UNKNOWN"
  );

  const unsafeConfirmed = structuredClone(report) as any;
  delete unsafeConfirmed.competitorItems[0].skus[0].promotions[0].activityPriceInclusion;
  assert.throws(
    () => collectorReportSchema.parse(unsafeConfirmed),
    /UNKNOWN public promotion inclusion cannot be CONFIRMED/
  );
});
```

Also assert that explicit `EXCLUDED` remains accepted and explicit `INCLUDED` is not subtracted.

- [ ] **Step 2: Add a failing runtime calculator test for an omitted tri-state field**

Use a deliberately legacy-shaped runtime value so the test covers JavaScript callers that bypass TypeScript:

```ts
test("treats an omitted tri-state field as unknown at runtime", () => {
  const legacyPromotion = {
    kind: "COUPON",
    label: "旧店铺券",
    amountFen: 1_000,
    thresholdFen: 50_000,
    audience: "PUBLIC",
    stackGroup: "shop-coupon",
    includedInActivityPrice: false
  } as unknown as PromotionEvidence;

  const result = calculatePublicPrice({
    listPriceFen: 70_000,
    activityPriceFen: 60_000,
    promotions: [legacyPromotion],
    mandatoryFeeFen: 0
  });

  assert.equal(result.confidence, "MANUAL_REVIEW");
  assert.equal(result.payableFen, null);
  assert.equal(result.publicDiscountFen, 0);
});
```

- [ ] **Step 3: Run the focused tests and verify the unsafe legacy behavior fails**

Run:

```bash
pnpm test:contracts
pnpm test:config
```

Expected before implementation: the contract leaves the tri-state field undefined or accepts the unsafe confirmed report, and the calculator returns a confirmed discounted price.

- [ ] **Step 4: Normalize promotion evidence in the Zod input schema**

Keep the old boolean as a strict compatibility input, but make the parsed field mandatory:

```ts
const promotionEvidenceSchema = z.object({
  kind: z.string().min(1).max(120),
  label: z.string().min(1).max(500),
  amountFen: moneyFenSchema.nullable(),
  thresholdFen: moneyFenSchema.nullable(),
  audience: z.string().min(1).max(120),
  stackGroup: z.string().min(1).max(120).nullable(),
  includedInActivityPrice: z.boolean(),
  activityPriceInclusion: z.enum(["INCLUDED", "EXCLUDED", "UNKNOWN"]).optional()
}).strict().transform((promotion) => ({
  ...promotion,
  activityPriceInclusion: promotion.activityPriceInclusion
    ?? (promotion.includedInActivityPrice ? "INCLUDED" : "UNKNOWN")
}));
```

In `collectorReportSchema.superRefine`, add an issue on `priceConfidence` when a confirmed SKU contains a public `UNKNOWN` promotion. Keep the existing non-negative component formula check.

- [ ] **Step 5: Remove the unsafe calculator fallback**

Change the calculator to treat any missing runtime value as unknown:

```ts
const inclusion = promotion.activityPriceInclusion ?? "UNKNOWN";
```

Do not infer exclusion from `includedInActivityPrice: false`.

- [ ] **Step 6: Mark trusted internal discounts as explicitly excluded**

In `PriceEngineService.calculate`, add `activityPriceInclusion: "EXCLUDED"` to the synthetic known public discounts. Update deterministic test fixtures in config, pricing, contracts, and desktop-report integration tests to use explicit `EXCLUDED`. Leave the real macOS parser's ambiguous visible promotion output as `UNKNOWN`.

- [ ] **Step 7: Run focused and portable verification**

Run:

```bash
pnpm test:contracts
pnpm test:config
pnpm test:api:portable
pnpm test:collector
pnpm typecheck
git diff --check
```

Expected: all commands pass; the new tests prove legacy false cannot become a confirmed discount.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts/src/desktop-collector.ts packages/contracts/src/desktop-collector.test.ts packages/config/src/public-price.ts packages/config/src/public-price.test.ts apps/api/src/pricing/price-engine.service.ts apps/api/src/pricing/price-engine.service.spec.ts apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts apps/collector/src/drivers/macos/taobao-price-evidence.ts apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts
git commit -m "fix: make promotion inclusion conservative"
```

---

### Task 2: Migrate Legacy Checkpoints Without Losing Progress

**Files:**
- Create: `apps/collector/src/core/legacy-checkpoint-price-migration.ts`
- Create: `apps/collector/src/core/legacy-checkpoint-price-migration.spec.ts`
- Modify: `apps/collector/src/core/checkpoint-store.ts`
- Modify: `apps/collector/src/core/checkpoint-store.spec.ts`

**Interfaces:**
- Consumes: raw JSON-compatible checkpoint report data before `collectorReportSchema.safeParse`.
- Consumes: `calculatePublicPrice(PublicPriceInput): PublicPriceResult` from `packages/config/src/public-price.ts`.
- Produces: `migrateLegacyCheckpointReport(value: unknown): unknown`.
- Guarantees: malformed unrelated data is not made valid; the strict report schema remains the final authority.
- Guarantees: valid old checkpoints retain progress arrays, evidence manifests, identities, rankings, and completed SKU keys.

- [ ] **Step 1: Add failing pure migration tests**

Create a legacy report fixture containing one public coupon with old `includedInActivityPrice: false`, no tri-state field, and an unsafe confirmed discounted price. Assert:

```ts
const migrated = migrateLegacyCheckpointReport(legacyReport) as any;
const sku = migrated.ownItems[0].skus[0];

assert.equal(sku.promotions[0].activityPriceInclusion, "UNKNOWN");
assert.equal(sku.couponDiscountFen, 0);
assert.equal(sku.fullReductionFen, 0);
assert.equal(sku.directDiscountFen, 0);
assert.equal(sku.payableFen, null);
assert.equal(sku.priceConfidence, "MANUAL_REVIEW");
assert.deepEqual(migrateLegacyCheckpointReport(migrated), migrated);
```

Add a second fixture with explicit `EXCLUDED`; assert its confirmed components and payable price are unchanged.

- [ ] **Step 2: Add a failing checkpoint-store progress-preservation test**

Write a raw legacy checkpoint with populated `completedOwnListingIds`, `completedPlatformItemIds`, `completedSkuKeys`, `evidenceManifest`, and `identityAliases`. Load it through `AtomicCheckpointStore` and assert:

```ts
assert.deepEqual(loaded?.completedPlatformItemIds, original.completedPlatformItemIds);
assert.deepEqual(loaded?.completedSkuKeys, original.completedSkuKeys);
assert.deepEqual(loaded?.evidenceManifest, original.evidenceManifest);
assert.equal(loaded?.report.ownItems[0]?.skus[0]?.priceConfidence, "MANUAL_REVIEW");
assert.equal(loaded?.report.ownItems[0]?.skus[0]?.payableFen, null);
```

Save and reload the migrated checkpoint, then assert the entire result is deeply equal to the first load.

- [ ] **Step 3: Run the focused collector tests and verify they fail**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/core/legacy-checkpoint-price-migration.spec.ts apps/collector/src/core/checkpoint-store.spec.ts
```

Expected before implementation: the new module is missing or the old checkpoint fails strict parsing instead of being downgraded safely.

- [ ] **Step 4: Implement the pure compatibility migration**

Implement a non-mutating JSON-object traversal:

```ts
export function migrateLegacyCheckpointReport(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const migrated = structuredClone(value);
  for (const collection of ["ownItems", "competitorItems"] as const) {
    const items = migrated[collection];
    if (!Array.isArray(items)) continue;
    for (const item of items) migrateItemSkus(item);
  }
  return migrated;
}
```

For every promotion object, set a missing tri-state field to `INCLUDED` only when the old boolean is `true`; otherwise set `UNKNOWN`. If a valid SKU has any public `UNKNOWN` promotion, call `calculatePublicPrice` with its list price, activity price, normalized promotions, and mandatory fee, then replace all three discount component fields, `payableFen`, and `priceConfidence` from the result. If required numeric or promotion fields are malformed, leave the normalized raw shape for the strict schema to reject; do not catch an error and invent a valid price.

- [ ] **Step 5: Apply migration before strict checkpoint report parsing**

In `parseCheckpoint`:

```ts
const migratedReport = migrateLegacyCheckpointReport(value.report);
const parsedReport = collectorReportSchema.safeParse(migratedReport);
```

Continue returning only `parsedReport.data`. Both `load` and `save` already pass through `parseCheckpoint`, so the next atomic save writes the normalized form.

- [ ] **Step 6: Run collector regression and type checks**

Run:

```bash
pnpm test:collector
pnpm test:contracts
pnpm test:config
pnpm typecheck
git diff --check
```

Expected: all tests pass; migration is idempotent and progress-preserving.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/collector/src/core/legacy-checkpoint-price-migration.ts apps/collector/src/core/legacy-checkpoint-price-migration.spec.ts apps/collector/src/core/checkpoint-store.ts apps/collector/src/core/checkpoint-store.spec.ts
git commit -m "fix: migrate legacy price checkpoints safely"
```

---

### Task 3: Persist the Notification Outbox Inside Alert Evaluation

**Files:**
- Create: `apps/api/src/alerts/run-alert-summary.persistence.ts`
- Create: `apps/api/src/alerts/run-alert-summary.persistence.spec.ts`
- Modify: `apps/api/src/alerts/prisma-run-alert-notification.repository.ts`
- Modify: `apps/api/src/alerts/run-alert-notifier.ts`
- Modify: `apps/api/src/alerts/run-alert-notifier.spec.ts`
- Modify: `apps/api/src/alerts/run-alert-reconciler.spec.ts`
- Modify: `apps/api/src/collection/run-alert.service.ts`
- Modify: `apps/api/src/collection/run-alert.service.spec.ts`
- Modify: `apps/api/src/collection/prisma-run-alert.repository.ts`
- Modify: `apps/api/src/collection/prisma-run-alert.repository.integration.spec.ts`

**Interfaces:**
- Produces: `runAlertSummaryToJson(summary: RunAlertSummary): Prisma.InputJsonValue`.
- Produces: `runAlertSummaryFromJson(value: Prisma.JsonValue): RunAlertSummary` with the existing strict validation.
- Produces: `RunAlertNotificationPersistenceError` from the shared persistence module so serialization and repository failures retain one sanitized error type.
- Extends: `RunAlertUnitOfWork.ensureNotificationBatch(summary: RunAlertSummary): Promise<void>`.
- Changes: `RunAlertNotificationRepository.claimBatch(runId: string, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null>`.
- Preserves: `RunAlertNotifier.send(summary: RunAlertSummary): Promise<void>` for reconciler call-site compatibility; it passes only `summary.runId` into `claimBatch`.
- Preserves: the stored batch summary is immutable and remains the source sent by WeCom.

- [ ] **Step 1: Add failing service tests that require transactional batch persistence**

Extend `FakeRunAlertRepository` with an `ensuredBatches` map and an `ensureNotificationBatch` method. Add assertions:

```ts
const summary = await service.evaluateRun("run-bare");
assert.deepEqual(repository.ensuredBatches.get("run-bare"), summary);
```

For a missing-baseline result, assert a batch is ensured despite `alerts: []`. For a run with no new alerts and no system issue, assert no batch is added.

- [ ] **Step 2: Add failing notifier tests proving it cannot create an absent batch**

Change the fake repository so `claimBatch(runId)` only reads a pre-seeded batch. Add:

```ts
test("never constructs a notification batch after evaluation", async () => {
  const repository = new FakeBatchRepository();
  const sender = new RecordingSender();
  const notifier = new RunAlertNotifier(repository, async () => sender);

  await notifier.send(summary("missing-outbox"));

  assert.equal(repository.batches.size, 0);
  assert.equal(sender.messages.length, 0);
});
```

Pre-seed batches in tests that exercise successful, failed, ambiguous, and retry sends. Keep the assertion that a changed later summary does not alter the originally stored message.

- [ ] **Step 3: Add failing PostgreSQL crash-boundary tests**

In the isolated integration suite, after `service.evaluateRun(firstRun.id)` and before constructing a notifier, assert:

```ts
const committedBatch = await prisma.runAlertNotificationBatch.findUniqueOrThrow({
  where: { collectionRunId: firstRun.id }
});
assert.deepEqual(committedBatch.alertIds.sort(), summaryWithAlerts.alerts.map((a) => a.alertId).sort());
assert.equal(committedBatch.state, "PENDING");
```

Simulate a process restart by constructing a fresh notification repository, notifier, and reconciler after evaluation. Call `reconcilePending`; assert exactly one message is sent and a second reconciliation sends none.

Add a transaction rollback test by invoking `PrismaRunAlertRepository.withEvaluation` for a seeded run, creating an alert and ensuring a batch in the unit of work, then throwing `new Error("simulated pre-commit crash")`. After rejection, assert neither the test alert nor the batch exists.

- [ ] **Step 4: Run the focused API tests and verify the gap is reproduced**

Run:

```bash
pnpm test:api:portable
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' pnpm db:migrate
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' pnpm test:api
```

Expected before implementation: no batch exists immediately after evaluation, and the reconstructed reconciler cannot recover a notification without first calling the old batch-creating sender.

- [ ] **Step 5: Extract strict summary serialization**

Move `RunAlertNotificationPersistenceError`, `summarySchema`, JSON conversion, and date restoration from `prisma-run-alert-notification.repository.ts` into `run-alert-summary.persistence.ts`:

```ts
export function runAlertSummaryToJson(summary: RunAlertSummary): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue;
}

export function runAlertSummaryFromJson(value: Prisma.JsonValue): RunAlertSummary {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) throw new RunAlertNotificationPersistenceError();
  return { ...parsed.data, completedAt: new Date(parsed.data.completedAt) };
}
```

Keep the existing field bounds and strict nested schemas unchanged. Add round-trip and invalid-JSON tests.

- [ ] **Step 6: Add batch persistence to the run-alert unit of work**

Add to `RunAlertUnitOfWork`:

```ts
ensureNotificationBatch(summary: RunAlertSummary): Promise<void>;
```

Implement it in `PrismaRunAlertUnitOfWork`:

```ts
async ensureNotificationBatch(summary: RunAlertSummary): Promise<void> {
  if (summary.runId !== this.data.runId) throw new RunAlertEvaluationError();
  if (summary.alerts.length === 0 && summary.systemIssue === null) return;
  await this.transaction.runAlertNotificationBatch.createMany({
    data: [{
      collectionRunId: summary.runId,
      summary: runAlertSummaryToJson(summary),
      alertIds: summary.alerts.map((alert) => alert.alertId)
    }],
    skipDuplicates: true
  });
}
```

The enclosing `CollectionRun FOR UPDATE` lock and unique `collectionRunId` make this idempotent. Add a unit test that a mismatched summary run ID is rejected. Never update an existing batch summary during reevaluation.

- [ ] **Step 7: Ensure every actionable evaluation summary is persisted before transaction return**

Inside `RunAlertService.evaluateRun`, centralize completion:

```ts
const complete = async (summary: RunAlertSummary): Promise<RunAlertSummary> => {
  await unit.ensureNotificationBatch(summary);
  return summary;
};
```

Return `complete(summary)` from both the baseline-system-issue branch and normal alert branch. The no-alert/no-system-issue summary remains a no-op inside the unit of work.

- [ ] **Step 8: Make the notifier claim only durable batches**

Change the repository interface and implementation:

```ts
claimBatch(runId: string, attemptedAt: Date): Promise<ClaimedRunAlertBatch | null>;
```

`PrismaRunAlertNotificationRepository.claimBatch` must lock the run, read the existing batch, and return `null` when no batch exists. Remove the code that creates a batch from the caller's summary. `RunAlertNotifier.send(summary)` calls `claimBatch(summary.runId, now)` and sends `claimed.summary`, never the caller-provided mutable summary.

- [ ] **Step 9: Run focused database and notification recovery tests**

Prepare the isolated schema and run:

```bash
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' pnpm db:migrate
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' pnpm test:api
pnpm test:api:portable
```

Expected: alert and batch commit together, pre-commit failure rolls both back, restart sends the stored summary once, and ambiguous delivery never repeats.

- [ ] **Step 10: Run the complete automated regression**

Run:

```bash
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' REDIS_HOST=127.0.0.1 REDIS_PORT=6380 pnpm verify
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' REDIS_HOST=127.0.0.1 REDIS_PORT=6380 pnpm test:browser
pnpm audit:public
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=collector_safety_repair' pnpm db:validate
swift build --package-path apps/collector-macos
swift test --package-path apps/collector-macos
git diff --check
```

Expected: all TypeScript, PostgreSQL, Redis, browser, build, and audit gates pass. On the current Command Line Tools-only host, record `swift test` as blocked only when the fresh output is exactly the known missing `XCTest` environment failure; do not claim Swift unit tests passed.

- [ ] **Step 11: Commit Task 3**

```bash
git add apps/api/src/alerts/run-alert-summary.persistence.ts apps/api/src/alerts/run-alert-summary.persistence.spec.ts apps/api/src/alerts/prisma-run-alert-notification.repository.ts apps/api/src/alerts/run-alert-notifier.ts apps/api/src/alerts/run-alert-notifier.spec.ts apps/api/src/alerts/run-alert-reconciler.spec.ts apps/api/src/collection/run-alert.service.ts apps/api/src/collection/run-alert.service.spec.ts apps/api/src/collection/prisma-run-alert.repository.ts apps/api/src/collection/prisma-run-alert.repository.integration.spec.ts
git commit -m "fix: persist alert notification outbox atomically"
```

---

## Final Review And Acceptance

After all three tasks pass their independent task reviews:

1. Generate a whole-plan review package from commit `17738aaf` to the repair head.
2. Dispatch one most-capable final reviewer with the design, this plan, task reports, ledger, and full diff.
3. The final reviewer must explicitly verify both prior blockers:
   - omitted or legacy-false promotion inclusion cannot cross any report/checkpoint boundary as a confirmed price;
   - there is no committed state where a newly persisted run alert needs notification but lacks a durable `RunAlertNotificationBatch`.
4. If findings remain, use the plan's normal bounded SDD fix loop. Do not repeat the previous plan's already-consumed final fix wave; this follow-up plan has its own ledger and review budget.
5. Do not delete either plan workspace until this repair's final review is clean.
6. Do not run supervised Taobao or real WeCom acceptance without fresh action-time user confirmation.
