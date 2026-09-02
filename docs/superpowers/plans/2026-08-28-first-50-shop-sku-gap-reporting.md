# First-50 Shop SKU Gap Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-50 Taobao price board that compares every confirmed competitor SKU against the lowest confirmed own SKU with the exact same combination, separately reports combinations missing from our configured catalog, and sends one auditable WeCom run summary.

**Architecture:** Enrich the collector contract with conservative component roles, create a deterministic `sku-combination-v1` canonicalizer, and persist each snapshot's combination state plus its selected own baseline. Aggregate the persisted facts into shop, confirmed-low, and missing-own report projections; render those projections in focused React sections; keep the existing durable notification outbox and add a one-time live-send approval gate.

**Tech Stack:** TypeScript 7, Node.js test runner, Zod, Prisma 7, PostgreSQL, NestJS 11, React 19, Ant Design 6, Vitest, Testing Library, existing desktop collector contracts.

## Global Constraints

- “前 50” means the first 50 displayed search positions, not 50 unique shops.
- Preserve every search rank even when the same item appears more than once; fetch one detail page per unique item.
- Compare only exact brand, standard model, condition, core model and quantity, paid accessory model and quantity, and configured material attributes.
- Include color in the combination only when `MonitoredModel.colorComparable=true`.
- Component roles are exactly `CORE`, `PAID_ACCESSORY`, `GIFT_OR_SERVICE`, and `UNKNOWN`.
- `GIFT_OR_SERVICE` is displayed but excluded from the signature; any material `UNKNOWN` component forces review.
- The signature format is exactly `sku-combination-v1:<64 lowercase hex SHA-256 characters>`.
- For each combination, choose the lowest in-stock `CONFIRMED` own payable price; retain every alternative own link.
- A competitor price lower by one fen is a confirmed low when every other comparison condition passes.
- `MISSING_OWN` never creates `PriceAlert` or `CollectionIssue` and never says that a competitor is lower than us.
- If any claimed own listing was not collected, absent combinations become `REVIEW` with `OWN_CATALOG_INCOMPLETE`.
- Search card prices are evidence only; comparisons use selected-SKU detail payable prices.
- Old runs remain readable with null combination fields and never receive retroactive alerts or notifications.
- Create at most one durable `RunAlertNotificationBatch` per run.
- Before the first real WeCom delivery, show the stored preview and require a fresh authenticated administrator confirmation.
- Never auto-change a store price and never bypass login, CAPTCHA, or platform challenges.
- Keep TypeScript and process paths portable across macOS and Windows.
- Use test-driven development and commit each task independently.

---

### Task 1: Enrich Collector Jobs and SKU Component Evidence

**Files:**
- Modify: `packages/contracts/src/desktop-collector.ts`
- Modify: `packages/contracts/src/desktop-collector.test.ts`
- Modify: `apps/api/src/collector-agent/prisma-collector-agent.repository.ts`
- Modify: `apps/api/src/collector-agent/collector-agent.service.spec.ts`
- Create: `apps/collector/src/core/sku-component-evidence.ts`
- Create: `apps/collector/src/core/sku-component-evidence.spec.ts`
- Modify: `apps/collector/src/core/collection-runner.ts`
- Modify: `apps/collector/src/core/collection-runner.spec.ts`

**Interfaces:**
- Produces: `SKU_COMPONENT_ROLES` and exported `SkuComponentRole`.
- Extends: `CollectedSkuComponent.role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN"`.
- Extends: `CollectorJob.rule.colorComparable: boolean`; legacy stored jobs parse as `false`.
- Produces: `deriveSkuComponents(input: SkuComponentEvidenceInput): CollectedSkuComponent[]`.
- Guarantees: every newly completed collector SKU contains at least one component; old reports with no components remain parseable.

- [ ] **Step 1: Add failing contract tests for role normalization and model color rules**

Add assertions:

```ts
const parsedJob = collectorJobSchema.parse({
  ...job,
  rule: { ...job.rule, colorComparable: true }
});
assert.equal(parsedJob.rule.colorComparable, true);

const legacyJob = structuredClone(job) as any;
delete legacyJob.rule.colorComparable;
assert.equal(collectorJobSchema.parse(legacyJob).rule.colorComparable, false);

const legacyReport = structuredClone(report) as any;
legacyReport.competitorItems[0].skus[0].components = [{
  accessoryType: "麦克风",
  brand: "RODE",
  modelOrName: "NT1S",
  quantity: 1
}];
assert.equal(
  collectorReportSchema.parse(legacyReport).competitorItems[0]?.skus[0]?.components?.[0]?.role,
  "UNKNOWN"
);
```

Also test all four explicit roles and reject an unknown role string.

- [ ] **Step 2: Add failing conservative derivation tests**

Create `sku-component-evidence.spec.ts` with these cases:

```ts
test("derives one core component for a plain single-product SKU", () => {
  assert.deepEqual(deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "颜色分类": "黑色", "套餐类型": "单麦克风" },
    explicitComponents: undefined
  }), [{
    role: "CORE",
    accessoryType: "核心产品",
    brand: "RODE",
    modelOrName: "NT1S",
    quantity: 1
  }]);
});

test("keeps an explicit audio interface as a paid accessory", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "NT1S + AI-1声卡" },
    explicitComponents: undefined
  });
  assert.equal(result.find((item) => item.modelOrName === "AI-1")?.role, "PAID_ACCESSORY");
});

test("marks a generic upgrade package as unknown", () => {
  const result = deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: { "套餐类型": "升级套餐二" },
    explicitComponents: undefined
  });
  assert.equal(result.some((item) => item.role === "UNKNOWN"), true);
});

test("preserves driver-supplied roles without reclassifying them", () => {
  const explicit = [{
    role: "GIFT_OR_SERVICE" as const,
    accessoryType: "服务",
    brand: null,
    modelOrName: "远程调试",
    quantity: 1
  }];
  assert.deepEqual(deriveSkuComponents({
    brand: "RODE",
    standardModel: "NT1S",
    selectedLabels: {},
    explicitComponents: explicit
  }), explicit);
});
```

- [ ] **Step 3: Run contract and focused collector tests to verify failure**

Run:

```bash
pnpm test:contracts
node --test apps/collector/src/core/sku-component-evidence.spec.ts
```

Expected: role and `colorComparable` are missing, and the derivation module cannot be imported.

- [ ] **Step 4: Extend the Zod contracts conservatively**

Add:

```ts
export const SKU_COMPONENT_ROLES = [
  "CORE", "PAID_ACCESSORY", "GIFT_OR_SERVICE", "UNKNOWN"
] as const;

const collectedSkuComponentSchema = z.object({
  role: z.enum(SKU_COMPONENT_ROLES).default("UNKNOWN"),
  accessoryType: z.string().min(1).max(200),
  brand: z.string().min(1).max(200).nullable(),
  modelOrName: z.string().min(1).max(500),
  quantity: positiveCountSchema
}).strict();
```

Add `colorComparable: z.boolean().default(false)` to `ruleSchema`. Keep `components` optional at the report boundary so old checkpoints and reports remain readable; new collector output is enforced in the runner tests.

- [ ] **Step 5: Implement exact conservative component derivation**

Create:

```ts
export interface SkuComponentEvidenceInput {
  brand: string;
  standardModel: string;
  selectedLabels: Record<string, string>;
  explicitComponents: CollectedSkuComponent[] | undefined;
}

export function deriveSkuComponents(
  input: SkuComponentEvidenceInput
): CollectedSkuComponent[];
```

Use these fixed rules in order:

1. Return a structured clone of non-empty `explicitComponents`.
2. Insert one `CORE` component for the monitored brand and standard model.
3. A dimension containing `数量`, `只数`, or `件数` may change core quantity only when its selected label contains one unambiguous positive integer followed by `只`, `件`, `个`, or `套`.
4. Ignore dimensions matching `颜色|色号` for component creation.
5. Split package labels on `+`, `＋`, `/`, `、`, or `搭配`; remove the token matching the core model.
6. Tokens containing `赠`, `免费`, `调试`, `安装`, `软件`, `驱动`, or `保养` become `GIFT_OR_SERVICE`.
7. Tokens containing an explicit model-like alphanumeric identifier plus `声卡`, `支架`, `耳机`, `音箱`, `线材`, `防喷`, `话放`, or `麦克风` become `PAID_ACCESSORY`.
8. Generic tokens such as `套餐一`, `升级版`, `豪华套装`, or any non-empty unclassified package token become `UNKNOWN`.
9. Deduplicate only components with identical role, normalized type, brand, model/name, and quantity.

Never infer a paid accessory's cash value.

- [ ] **Step 6: Persist explicit job color semantics and derive components in the runner**

In `PrismaCollectorAgentRepository.claimNext`, add:

```ts
colorComparable: run.monitoredModel.colorComparable,
```

Add `colorComparable: true` to the `monitoredModel.select` block before constructing the job; do not rely on an unselected Prisma field.

In the runner's collected SKU construction, replace the optional component pass-through with:

```ts
components: deriveSkuComponents({
  brand: job.rule.brand,
  standardModel: job.rule.standardModel,
  selectedLabels: view.selectedLabels,
  explicitComponents: view.components
}),
```

Update fixtures to include the parsed default and assert newly completed SKUs always contain components.

- [ ] **Step 7: Run contract, collector, and type verification**

Run:

```bash
pnpm test:contracts
pnpm test:collector
pnpm test:api:portable
pnpm typecheck
git diff --check
```

Expected: all commands pass; legacy inputs become `UNKNOWN`, while every new runner output has a core component.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts/src/desktop-collector.ts packages/contracts/src/desktop-collector.test.ts apps/api/src/collector-agent/prisma-collector-agent.repository.ts apps/api/src/collector-agent/collector-agent.service.spec.ts apps/collector/src/core/sku-component-evidence.ts apps/collector/src/core/sku-component-evidence.spec.ts apps/collector/src/core/collection-runner.ts apps/collector/src/core/collection-runner.spec.ts
git commit -m "feat: capture conservative SKU component roles"
```

---

### Task 2: Persist Per-Snapshot Combination Evaluation

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260828100000_add_sku_combination_evaluation/migration.sql`
- Create: `apps/api/src/collection/prisma-sku-combination-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma enum `SkuCombinationState` with `OWN`, `MATCHED`, `MISSING_OWN`, `REVIEW`, and `EXCLUDED`.
- Extends: `OfferSnapshot` with nullable signature, label, state, reasons, and self-referenced selected own snapshot.
- Keeps: `CollectionRun.ownBaselineSnapshotId` as a nullable compatibility field.

- [ ] **Step 1: Add a failing schema integration test**

Create an isolated-schema test that inserts one own and one competitor snapshot in the same run, then updates the competitor:

```ts
await prisma.offerSnapshot.update({
  where: { id: competitor.id },
  data: {
    combinationSignature: `sku-combination-v1:${"a".repeat(64)}`,
    combinationLabel: "RODE NT1S 新品 单只",
    combinationState: "MATCHED",
    combinationReasons: { ruleVersion: "sku-combination-v1", codes: ["EXACT_SIGNATURE"] },
    comparisonOwnSnapshotId: own.id
  }
});

const stored = await prisma.offerSnapshot.findUniqueOrThrow({
  where: { id: competitor.id },
  include: { comparisonOwnSnapshot: true }
});
assert.equal(stored.comparisonOwnSnapshot?.id, own.id);
```

Also insert an old-style snapshot and assert all five new fields are null.

- [ ] **Step 2: Run database validation and verify the new fields are absent**

Run:

```bash
pnpm db:validate
pnpm test:api
```

Expected before implementation: the integration test does not compile against the generated Prisma client.

- [ ] **Step 3: Add the Prisma enum, fields, relation, and indexes**

Use:

```prisma
enum SkuCombinationState {
  OWN
  MATCHED
  MISSING_OWN
  REVIEW
  EXCLUDED
}

model OfferSnapshot {
  combinationSignature        String?              @db.VarChar(100)
  combinationLabel            String?              @db.VarChar(1000)
  combinationState            SkuCombinationState?
  combinationReasons          Json?
  comparisonOwnSnapshotId     String?
  comparisonOwnSnapshot       OfferSnapshot?        @relation("OfferComparisonOwn", fields: [comparisonOwnSnapshotId], references: [id], onDelete: SetNull)
  comparedCompetitorSnapshots OfferSnapshot[]       @relation("OfferComparisonOwn")

  @@index([collectionRunId, combinationState])
  @@index([collectionRunId, combinationSignature])
  @@index([collectionRunId, shopName])
  @@index([comparisonOwnSnapshotId])
}
```

Keep every new scalar nullable and do not assign a default state.

- [ ] **Step 4: Write the explicit PostgreSQL migration**

The migration must:

```sql
CREATE TYPE "SkuCombinationState" AS ENUM ('OWN', 'MATCHED', 'MISSING_OWN', 'REVIEW', 'EXCLUDED');
ALTER TABLE "OfferSnapshot"
  ADD COLUMN "combinationSignature" VARCHAR(100),
  ADD COLUMN "combinationLabel" VARCHAR(1000),
  ADD COLUMN "combinationState" "SkuCombinationState",
  ADD COLUMN "combinationReasons" JSONB,
  ADD COLUMN "comparisonOwnSnapshotId" TEXT;
ALTER TABLE "OfferSnapshot"
  ADD CONSTRAINT "OfferSnapshot_comparisonOwnSnapshotId_fkey"
  FOREIGN KEY ("comparisonOwnSnapshotId") REFERENCES "OfferSnapshot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OfferSnapshot_collectionRunId_combinationState_idx"
  ON "OfferSnapshot"("collectionRunId", "combinationState");
CREATE INDEX "OfferSnapshot_collectionRunId_combinationSignature_idx"
  ON "OfferSnapshot"("collectionRunId", "combinationSignature");
CREATE INDEX "OfferSnapshot_collectionRunId_shopName_idx"
  ON "OfferSnapshot"("collectionRunId", "shopName");
CREATE INDEX "OfferSnapshot_comparisonOwnSnapshotId_idx"
  ON "OfferSnapshot"("comparisonOwnSnapshotId");
```

- [ ] **Step 5: Generate, validate, and test the schema**

Run:

```bash
pnpm db:generate
pnpm db:validate
pnpm test:api
git diff --check
```

Expected: the isolated integration test passes and existing rows require no backfill.

- [ ] **Step 6: Commit Task 2**

```bash
git add prisma/schema.prisma prisma/migrations/20260828100000_add_sku_combination_evaluation/migration.sql apps/api/src/collection/prisma-sku-combination-schema.integration.spec.ts
git commit -m "feat: persist SKU combination evaluations"
```

---

### Task 3: Build Deterministic SKU Combination Signatures

**Files:**
- Create: `apps/api/src/pricing/sku-combination.ts`
- Create: `apps/api/src/pricing/sku-combination.spec.ts`

**Interfaces:**
- Produces: `buildSkuCombination(input: SkuCombinationInput): SkuCombinationBuildResult`.
- Produces: signed results with canonical data, human label, reasons, and `sku-combination-v1` SHA-256.
- Produces: review and excluded results with no signature.
- Consumes: product-level decision, monitor model fields, SKU attributes, and structured component roles.

- [ ] **Step 1: Add failing signature invariance and difference tests**

Create tests asserting:

```ts
const first = signed(buildSkuCombination(baseInput({
  components: [core, paidAccessory]
})));
const reordered = signed(buildSkuCombination(baseInput({
  components: [paidAccessory, core]
})));
assert.equal(first.signature, reordered.signature);

const twoUnits = signed(buildSkuCombination(baseInput({
  components: [{ ...core, quantity: 2 }, paidAccessory]
})));
assert.notEqual(first.signature, twoUnits.signature);

const giftChanged = signed(buildSkuCombination(baseInput({
  components: [core, paidAccessory, remoteService]
})));
assert.equal(first.signature, giftChanged.signature);
```

Add cases for paid accessory model changes, `UNKNOWN`, color enabled/disabled, region and warranty attributes, rejected product decisions, and stable lowercase 64-hex output.

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run:

```bash
node --test apps/api/src/pricing/sku-combination.spec.ts
```

Expected: import failure for `sku-combination.ts`.

- [ ] **Step 3: Define the exact public types**

Use:

```ts
export interface SkuCombinationInput {
  productDecision: "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | "PENDING" | null;
  brand: string;
  standardModel: string;
  version: string | null;
  colorComparable: boolean;
  title: string;
  skuText: string;
  attributes: Record<string, string>;
  components: Array<{
    role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
    accessoryType: string;
    brand: string | null;
    modelOrName: string;
    quantity: number;
  }> | null;
}

export type SkuCombinationBuildResult =
  | { kind: "SIGNED"; signature: string; label: string; canonical: CanonicalSkuCombination; reasons: string[] }
  | { kind: "REVIEW"; signature: null; label: string | null; reasons: string[] }
  | { kind: "EXCLUDED"; signature: null; label: null; reasons: string[] };
```

- [ ] **Step 4: Implement canonical normalization**

Apply these exact rules:

- `REJECTED` returns `EXCLUDED`; null, `PENDING`, or `MANUAL` returns `REVIEW`.
- Missing components, no `CORE`, any `UNKNOWN`, invalid quantity, or an empty normalized component name returns `REVIEW`.
- Normalize text with Unicode NFKC, lowercase, trimmed internal whitespace, and existing brand/model alias normalization from `MatcherService` utilities.
- Treat the condition as `new` after an exact product-level match; if title or SKU contains `二手`, `样机`, `展示机`, `翻新`, `租赁`, or `定金`, return `EXCLUDED` defensively.
- Include `CORE` and `PAID_ACCESSORY`, stable-sorted by role, normalized type, brand, model/name, and quantity.
- Exclude `GIFT_OR_SERVICE` from canonical JSON while adding a display reason.
- Include normalized attributes whose keys match `版本|区域|地区|国行|保修|质保`.
- When `colorComparable=true`, require and include the first normalized attribute whose key matches `颜色|色号`; when false, canonical color is null.
- Serialize a fixed-key object with arrays already sorted; hash the UTF-8 JSON using `createHash("sha256")`.

Return a concise Chinese label generated from brand, standard model, `新品`, core quantities, paid accessories, material attributes, and optional color.

- [ ] **Step 5: Run focused and API portable tests**

Run:

```bash
node --test apps/api/src/pricing/sku-combination.spec.ts
pnpm test:api:portable
pnpm typecheck
git diff --check
```

Expected: signatures are deterministic, gifts do not alter them, and uncertainty never produces a signature.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/api/src/pricing/sku-combination.ts apps/api/src/pricing/sku-combination.spec.ts
git commit -m "feat: build deterministic SKU combination signatures"
```

---

### Task 4: Select Per-Combination Own Baselines and Classify Competitors

**Files:**
- Create: `apps/api/src/collection/run-sku-comparison.ts`
- Create: `apps/api/src/collection/run-sku-comparison.spec.ts`

**Interfaces:**
- Produces: `evaluateRunSkuCombinations(input: RunSkuComparisonInput): RunSkuComparisonResult`.
- Produces: one persistence decision per snapshot, selected and alternative own baselines per signature, competitor comparisons, grouped missing combinations, and summary counts.
- Consumes: completed product-level decisions and `buildSkuCombination` results.

- [ ] **Step 1: Add failing lowest-baseline and missing-group tests**

Cover these exact scenarios:

```ts
const result = evaluateRunSkuCombinations(runInput({
  own: [own("own-high", 61_000), own("own-low", 60_000)],
  competitors: [competitor("competitor-1", 58_900)]
}));
assert.equal(result.bySnapshotId.get("competitor-1")?.state, "MATCHED");
assert.equal(result.bySnapshotId.get("competitor-1")?.comparisonOwnSnapshotId, "own-low");
assert.deepEqual(result.baselinesBySignature[0]?.alternativeSnapshotIds, ["own-high"]);

const missing = evaluateRunSkuCombinations(runInput({
  own: [own("single-mic", 148_000)],
  competitors: [bundleCompetitor("with-ai1", 188_000, "AI-1")]
}));
assert.equal(missing.bySnapshotId.get("with-ai1")?.state, "MISSING_OWN");
assert.equal(missing.missingOwnGroups.length, 1);
assert.equal(missing.alertCandidates.length, 0);
```

Also test one-fen lower, equal price, unconfirmed own price, own out of stock, incomplete own catalog, unconfirmed competitor price, out-of-stock competitor, deterministic ties, and grouping the same missing signature across several shops.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test apps/api/src/collection/run-sku-comparison.spec.ts
```

Expected: import failure for the new evaluator.

- [ ] **Step 3: Define evaluator input and output types**

Use:

```ts
export interface RunSkuComparisonCandidate {
  snapshotId: string;
  source: "OWN" | "COMPETITOR";
  platformItemId: string;
  skuId: string;
  shopName: string;
  searchRanks: number[];
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  priceConfidence: "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";
  payableFen: number | null;
  combination: SkuCombinationBuildResult;
}

export interface SnapshotCombinationDecision {
  snapshotId: string;
  signature: string | null;
  label: string | null;
  state: "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";
  comparisonOwnSnapshotId: string | null;
  reasons: string[];
}
```

`RunSkuComparisonInput` also contains `ownCatalogComplete: boolean`. The result includes `bySnapshotId`, `baselinesBySignature`, `alertCandidates`, `missingOwnGroups`, `reviewCount`, and `primaryOwnSnapshotId`.

- [ ] **Step 4: Implement deterministic own indexes**

Create two maps per signed own combination:

- all signed own snapshots, including unavailable or unconfirmed rows;
- eligible baselines restricted to `IN_STOCK`, `CONFIRMED`, and non-null payable price.

Sort eligible rows by `payableFen`, `platformItemId`, `skuId`, and `snapshotId`. Mark every eligible selected or alternative own snapshot as `OWN`; retain review reasons for ineligible own rows.

Select `primaryOwnSnapshotId` from the selected baseline of every signature using the same payable-price and identifier ordering. This field exists only for the legacy run-level baseline reference and never drives competitor comparisons.

- [ ] **Step 5: Implement competitor state precedence**

Use this order:

1. `EXCLUDED` combination result -> `EXCLUDED`.
2. `REVIEW` combination result, unknown/out-of-stock competitor, or non-confirmed competitor price -> `REVIEW`.
3. Eligible own baseline with the same signature -> `MATCHED` and bind the first sorted own snapshot.
4. Same-signature own rows exist but any has an unconfirmed price -> `REVIEW` with `OWN_PRICE_UNCONFIRMED`.
5. Same-signature own rows exist but all are out of stock -> `MISSING_OWN` with `OWN_OUT_OF_STOCK_ONLY`.
6. No same-signature own row and `ownCatalogComplete=false` -> `REVIEW` with `OWN_CATALOG_INCOMPLETE`.
7. No same-signature own row and complete catalog -> `MISSING_OWN` with `OWN_COMBINATION_ABSENT`.

Only `MATCHED` rows with competitor price strictly below the selected own price enter `alertCandidates`.

- [ ] **Step 6: Group missing combinations without creating alerts**

For each missing signature, return one group containing the label, reason, earliest rank, minimum confirmed payable price, distinct shops, and sorted offer snapshot IDs. Sort groups by minimum price then earliest rank then signature.

- [ ] **Step 7: Run focused and portable verification**

Run:

```bash
node --test apps/api/src/collection/run-sku-comparison.spec.ts
pnpm test:api:portable
pnpm typecheck
git diff --check
```

Expected: all evaluator tests pass and no missing or review row is an alert candidate.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/api/src/collection/run-sku-comparison.ts apps/api/src/collection/run-sku-comparison.spec.ts
git commit -m "feat: evaluate per-combination own baselines"
```

---

### Task 5: Wire Combination Evaluation into the Durable Alert Transaction

**Files:**
- Modify: `apps/api/src/alerts/alert-dedup.ts`
- Modify: `apps/api/src/alerts/alert.service.ts`
- Modify: `apps/api/src/alerts/alert.service.spec.ts`
- Modify: `apps/api/src/collection/run-alert.service.ts`
- Modify: `apps/api/src/collection/run-alert.service.spec.ts`
- Modify: `apps/api/src/collection/prisma-run-alert.repository.ts`
- Modify: `apps/api/src/collection/prisma-run-alert.repository.integration.spec.ts`
- Modify: `apps/api/src/alerts/run-alert-summary.persistence.ts`
- Modify: `apps/api/src/alerts/run-alert-summary.persistence.spec.ts`

**Interfaces:**
- Produces: `SnapshotCombinationPersistence` and `RunAlertUnitOfWork.saveCombinationDecisions`.
- Extends: `RunAlertData.model.colorComparable` and `RunAlertData.claimedOwnListingIds`.
- Extends: each `RunAlertEntry` with selected own snapshot, own SKU text, own payable price, combination signature, and combination label.
- Extends: `AlertOffer.combinationSignature` and the alert dedup key so the exact combination and selected own snapshot are part of identity.
- Extends: `RunAlertSummary` with position count, shop count, review count, and missing-own groups.
- Guarantees: match decisions, combination decisions, price alerts, compatibility baseline, and notification batch commit in one PostgreSQL transaction.

- [ ] **Step 1: Replace single-baseline service tests with per-combination expectations**

Add or update tests so one run contains two own combinations and three competitors:

```ts
const summary = await service.evaluateRun("run-multi-baseline");

assert.deepEqual(
  repository.savedCombinationDecisions.map((item) => [item.snapshotId, item.state]),
  [
    ["own-single", "OWN"],
    ["own-bundle", "OWN"],
    ["competitor-single-low", "MATCHED"],
    ["competitor-bundle-equal", "MATCHED"],
    ["competitor-missing", "MISSING_OWN"]
  ]
);
assert.equal(summary.alerts.length, 1);
assert.equal(summary.alerts[0]?.ownSnapshotId, "own-single");
assert.equal(summary.missingOwnGroups.length, 1);
assert.equal(repository.notificationBatches.length, 1);
```

Add tests proving a one-fen low alerts, equal price does not, missing does not create an alert or issue, deterministic multiple own links do not create `OWN_BASELINE_AMBIGUOUS`, and an incomplete claimed own catalog converts absence to review.

Add an `AlertService` test asserting two alerts with the same competitor item, SKU, and price but different combination signatures or selected own snapshot IDs receive different `price-v3` dedup keys.

- [ ] **Step 2: Add a failing repository integration test for atomic persistence**

After evaluation, assert in one database read:

```ts
const competitor = await prisma.offerSnapshot.findUniqueOrThrow({
  where: { id: competitorSnapshot.id }
});
assert.equal(competitor.combinationState, "MATCHED");
assert.equal(competitor.comparisonOwnSnapshotId, lowestOwnSnapshot.id);
assert.equal(await prisma.priceAlert.count({ where: { competitorSnapshotId: competitor.id } }), 1);
assert.equal(await prisma.runAlertNotificationBatch.count({ where: { collectionRunId: run.id } }), 1);
```

For a missing competitor, assert `MISSING_OWN`, null own reference, zero alerts, and zero new collection issues.

- [ ] **Step 3: Run focused tests and verify the old singular assumption fails**

Run:

```bash
node --test apps/api/src/collection/run-alert.service.spec.ts apps/api/src/alerts/run-alert-summary.persistence.spec.ts
pnpm test:api
```

Expected: the service still reports `OWN_BASELINE_AMBIGUOUS` or uses one baseline for every competitor.

- [ ] **Step 4: Parse component roles and claimed-own completeness in the repository**

Replace `bundleComponentsFromJson` with strict role-aware parsing that accepts only the four contract roles and returns null for malformed data. Select `claimedOwnListingIds` and `colorComparable` with the run and model.

Compute:

```ts
const collectedOwnListingIds = new Set(
  snapshots.flatMap((snapshot) => snapshot.ownListingId ? [snapshot.ownListingId] : [])
);
const ownCatalogComplete = run.claimedOwnListingIds.length > 0
  && run.claimedOwnListingIds.every((id) => collectedOwnListingIds.has(id));
```

Expose the boolean and claimed IDs to the service.

- [ ] **Step 5: Add combination persistence to the unit of work**

Define:

```ts
export interface SnapshotCombinationPersistence {
  snapshotId: string;
  signature: string | null;
  label: string | null;
  state: "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";
  comparisonOwnSnapshotId: string | null;
  reasons: {
    ruleVersion: "sku-combination-v1";
    codes: string[];
  };
}
```

`saveCombinationDecisions` must update with both snapshot and selected own snapshot constrained to the same run. Throw `RunAlertEvaluationError` if either does not belong to the run.

- [ ] **Step 6: Refactor `RunAlertService.evaluateRun` around the pure evaluator**

Keep product-level `MatcherService` decisions, then:

```ts
const combinationCandidates = evaluated.map((entry) => ({
  snapshotId: entry.snapshot.id,
  source: entry.snapshot.ownListingId ? "OWN" as const : "COMPETITOR" as const,
  platformItemId: entry.snapshot.platformItemId,
  skuId: entry.snapshot.skuId,
  shopName: entry.snapshot.shopName,
  searchRanks: entry.snapshot.searchRanks,
  stockState: entry.snapshot.stockState,
  priceConfidence: entry.snapshot.priceConfidence,
  payableFen: entry.snapshot.payableFen,
  combination: buildSkuCombination({
    productDecision: entry.persistence.decision,
    brand: data.model.brand,
    standardModel: data.model.standardModel,
    version: data.model.version,
    colorComparable: data.model.colorComparable,
    title: entry.snapshot.title,
    skuText: entry.snapshot.skuText,
    attributes: entry.snapshot.attributes,
    components: entry.snapshot.components
  })
}));
const comparison = evaluateRunSkuCombinations({
  candidates: combinationCandidates,
  ownCatalogComplete: data.ownCatalogComplete
});
```

Persist all combination decisions. Set the compatibility `ownBaselineSnapshotId` to `comparison.primaryOwnSnapshotId`, the lowest selected baseline across signatures, or null.

- [ ] **Step 7: Create alerts only for pure evaluator candidates**

Call `AlertService.evaluate` once per `alertCandidate`, pairing its actual selected own snapshot. Do not call it for `MISSING_OWN`, `REVIEW`, `EXCLUDED`, equal, or higher rows. Populate every alert entry with both sides' snapshot and price fields.

Change `dedupKey` to hash this exact canonical object:

```ts
{
  monitoredModelId,
  combinationSignature,
  ownSnapshotId,
  competitorItemId,
  competitorSkuId,
  competitorPriceFen
}
```

Prefix new keys with `price-v3:`. Existing `price-v2` rows remain valid historical records; do not rewrite them.

Remove the `ownBaselines.length !== 1` branch. Keep `OWN_BASELINE_MISSING` only when no claimed own listing produced any snapshot; never create `OWN_BASELINE_AMBIGUOUS` under the new deterministic tie rule.

- [ ] **Step 8: Persist one summary batch for every evaluated terminal run**

Define the extended summary records before changing persistence:

```ts
export interface RunAlertEntry {
  alertId: string;
  severity: "CONFIRMED_LOW";
  snapshotId: string;
  ownSnapshotId: string;
  ownSkuText: string;
  ownPayableFen: number;
  combinationSignature: string;
  combinationLabel: string;
  rank: number | null;
  shopName: string;
  title: string;
  skuText: string;
  activityPriceFen: number;
  publicDiscountFen: number;
  payableFen: number;
  differenceFen: number;
  url: string;
  reasons: string[];
}

export interface RunAlertMissingOwnGroup {
  combinationSignature: string;
  combinationLabel: string;
  missingReason: "OWN_COMBINATION_ABSENT" | "OWN_OUT_OF_STOCK_ONLY";
  earliestRank: number | null;
  minimumConfirmedPayableFen: number;
  shopCount: number;
  representativeUrl: string;
}
```

Extend summary persistence with:

```ts
positionCount: z.number().int().nonnegative(),
shopCount: z.number().int().nonnegative(),
reviewCount: z.number().int().nonnegative(),
missingOwnGroups: z.array(missingOwnGroupSchema),
```

Change `ensureNotificationBatch` so an evaluated run with zero alerts still receives one batch. Continue using `createMany(..., skipDuplicates: true)` and derive `alertIds` from `summary.alerts`.

Until Task 8 installs the default-deny live-send gate, execute only automated tests with injected fake senders; do not start the local runtime with a real WeCom webhook configured.

- [ ] **Step 9: Run unit, database, idempotency, and portable tests**

Run:

```bash
node --test apps/api/src/alerts/alert.service.spec.ts apps/api/src/collection/run-alert.service.spec.ts apps/api/src/alerts/run-alert-summary.persistence.spec.ts
pnpm test:api
pnpm test:contracts
pnpm typecheck
git diff --check
```

Expected: multi-baseline runs evaluate atomically, repeated evaluation creates no duplicate alerts or batches, and missing groups never create alerts.

- [ ] **Step 10: Commit Task 5**

```bash
git add apps/api/src/alerts/alert-dedup.ts apps/api/src/alerts/alert.service.ts apps/api/src/alerts/alert.service.spec.ts apps/api/src/collection/run-alert.service.ts apps/api/src/collection/run-alert.service.spec.ts apps/api/src/collection/prisma-run-alert.repository.ts apps/api/src/collection/prisma-run-alert.repository.integration.spec.ts apps/api/src/alerts/run-alert-summary.persistence.ts apps/api/src/alerts/run-alert-summary.persistence.spec.ts
git commit -m "feat: evaluate alerts with per-combination baselines"
```

---

### Task 6: Build Shop, Confirmed-Low, and Missing-Own Report Projections

**Files:**
- Create: `apps/api/src/operations/collection-report-aggregation.ts`
- Create: `apps/api/src/operations/collection-report-aggregation.spec.ts`
- Modify: `apps/api/src/operations/collection-report-query.service.ts`
- Modify: `apps/api/src/operations/collection-report-query.service.spec.ts`
- Modify: `apps/api/src/operations/collection-report-query.prisma.integration.spec.ts`
- Modify: `apps/api/src/http/operations-collection-runs-http.controller.ts`
- Modify: `apps/api/src/http/operations-collection-runs-http.controller.spec.ts`

**Interfaces:**
- Produces: `aggregateCollectionRunReport(input): CollectionRunBusinessSections`.
- Extends: `CollectionRunReportDetail` with `businessSummary`, `priceBoard`, `confirmedLows`, `missingOwnGroups`, and `reviewRows`.
- Extends: SKU rows with components, promotions, combination state, combination label/signature/reasons, selected own row, and alternative own rows.
- Keeps: existing positions, issues, paged audit SKUs, and evidence routes.

- [ ] **Step 1: Add failing pure aggregation tests**

Use a fixture with ranks `1` and `4` pointing to the same item, two products in one shop, one confirmed low, and the same missing combination in two shops. Assert:

```ts
const result = aggregateCollectionRunReport(input);
assert.deepEqual(result.priceBoard.shops[0]?.ranks, [1, 4, 7]);
assert.equal(result.priceBoard.shops[0]?.itemCount, 2);
assert.equal(result.confirmedLows.length, 1);
assert.equal(result.confirmedLows[0]?.selectedOwnSnapshot.id, "own-low");
assert.equal(result.missingOwnGroups.length, 1);
assert.equal(result.missingOwnGroups[0]?.shops.length, 2);
assert.equal(result.missingOwnGroups[0]?.minimumConfirmedPayableFen, 188_000);
```

Also assert stable shop order by earliest rank and stable confirmed-low order by descending difference then ascending rank.

- [ ] **Step 2: Add failing report-service tests for legacy and new runs**

For a new run, assert:

```ts
assert.deepEqual(detail.businessSummary, {
  distinctShopCount: 2,
  distinctItemCount: 3,
  skuCount: 6,
  matchedSkuCount: 2,
  confirmedLowCount: 1,
  missingCombinationCount: 1,
  reviewCount: 1,
  excludedCount: 1,
  ownConfiguredListingCount: 2,
  ownCollectedListingCount: 2,
  ownCatalogComplete: true
});
```

For a historical run whose combination fields are null, assert all rows display as legacy review, the page still opens, and no business section invents a low or missing group.

- [ ] **Step 3: Run focused API tests and verify new sections are absent**

Run:

```bash
node --test apps/api/src/operations/collection-report-aggregation.spec.ts apps/api/src/operations/collection-report-query.service.spec.ts apps/api/src/http/operations-collection-runs-http.controller.spec.ts
```

Expected: the aggregation module and new response fields do not exist.

- [ ] **Step 4: Define projection types and pure grouping**

Create types whose top-level shape is:

```ts
export interface CollectionRunBusinessSections {
  businessSummary: CollectionRunBusinessSummary;
  priceBoard: { shops: CollectionRunShopGroup[] };
  confirmedLows: CollectionRunConfirmedLow[];
  missingOwnGroups: CollectionRunMissingOwnGroup[];
  reviewRows: CollectionRunBusinessSkuRow[];
}
```

Group positions by `platformItemId`, then snapshots by normalized shop name and item. Preserve original shop text for display. Every SKU row includes all sorted ranks, full URL, structured components, promotions, stock, prices, combination facts, selected own snapshot, alternatives, and signed difference.

- [ ] **Step 5: Fetch complete business facts without replacing paged audit rows**

Add a repository method that loads all snapshots for one run with:

- new combination columns;
- `rawEvidence` components and attributes;
- `promotions` and `gifts`;
- the selected `comparisonOwnSnapshot`;
- every same-signature own snapshot for alternatives;
- all search positions and claimed own listing IDs.

Keep the existing paged `listSnapshots` path for the audit table. Do not compute business sections from only the current SKU page.

- [ ] **Step 6: Make legacy and filter behavior explicit**

- Null combination state becomes a report-only `REVIEW` row with reason `LEGACY_COMBINATION_NOT_EVALUATED`.
- `price=LOWER` filters only persisted `MATCHED` rows whose selected own price is greater.
- `price=NOT_LOWER` filters persisted `MATCHED` rows that are equal or higher.
- Existing `match` filters continue to use product match fields.
- Add optional `combinationState` query validation for all five states.

- [ ] **Step 7: Run unit and Prisma integration tests**

Run:

```bash
node --test apps/api/src/operations/collection-report-aggregation.spec.ts apps/api/src/operations/collection-report-query.service.spec.ts apps/api/src/http/operations-collection-runs-http.controller.spec.ts
pnpm test:api
pnpm typecheck
git diff --check
```

Expected: shop counts and duplicate ranks match raw positions, while historical runs stay readable.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/api/src/operations/collection-report-aggregation.ts apps/api/src/operations/collection-report-aggregation.spec.ts apps/api/src/operations/collection-report-query.service.ts apps/api/src/operations/collection-report-query.service.spec.ts apps/api/src/operations/collection-report-query.prisma.integration.spec.ts apps/api/src/http/operations-collection-runs-http.controller.ts apps/api/src/http/operations-collection-runs-http.controller.spec.ts
git commit -m "feat: expose first-50 SKU business reports"
```

---

### Task 7: Render the Three Business Report Sections

**Files:**
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/collection-runs.ts`
- Modify: `apps/web/src/api/collection-runs.test.ts`
- Create: `apps/web/src/features/collection-runs/RunBusinessSummary.tsx`
- Create: `apps/web/src/features/collection-runs/PriceBoardSection.tsx`
- Create: `apps/web/src/features/collection-runs/ConfirmedLowsSection.tsx`
- Create: `apps/web/src/features/collection-runs/MissingOwnSection.tsx`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.tsx`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: the Task 6 report response without client-side price or combination inference.
- Produces: summary metrics plus “前 50 价盘”, “确认低价同行”, and “我方缺失组合”.
- Keeps: the existing positions, issues, and paged SKU audit sections below the business sections.

- [ ] **Step 1: Add a failing page test for all three sections**

Render a report fixture and assert:

```tsx
expect(screen.getByText("前 50 价盘")).toBeInTheDocument();
expect(screen.getByText("确认低价同行")).toBeInTheDocument();
expect(screen.getByText("我方缺失组合")).toBeInTheDocument();
expect(screen.getByText("索尼聚鑫数码商城")).toBeInTheDocument();
expect(screen.getByText("低 ¥21.00")).toBeInTheDocument();
expect(screen.getByText("无同组合我方基准，不属于低价告警")).toBeInTheDocument();
expect(screen.getByText("排名 1、4")).toBeInTheDocument();
```

Click a shop expansion control and assert every product URL, SKU label, activity summary, stock state, selected own price, and alternative own link appears.

- [ ] **Step 2: Add a failing narrow-layout contract test**

Assert the three table wrappers use a stable class and Ant Design horizontal scroll configuration rather than shrinking columns:

```tsx
expect(container.querySelectorAll(".run-business-table-scroll")).toHaveLength(3);
expect(container.querySelector(".run-business-table-scroll .ant-table-content"))
  .toHaveStyle({ overflowX: "auto" });
```

- [ ] **Step 3: Run the focused web tests and verify failure**

Run:

```bash
pnpm --filter @stau-price-monitor/web test -- CollectionRunDetailPage.test.tsx collection-runs.test.ts
```

Expected: new sections and response types are absent.

- [ ] **Step 4: Mirror API types exactly**

Add exported web types for component roles, combination states, shop groups, confirmed lows, missing groups, review rows, selected own summaries, and `businessSummary`. Do not use `any`; represent promotion payloads with the existing contract fields.

- [ ] **Step 5: Build compact section components**

- `RunBusinessSummary` renders search completion, shops, items, SKUs, lows, missing combinations, reviews, anomalies, and own-catalog completeness in a compact responsive grid.
- `PriceBoardSection` uses an expandable shop table sorted by server order; the nested content is an unframed item/SKU table, not nested cards.
- `ConfirmedLowsSection` displays only server-confirmed rows, selected own baseline, alternatives, signed difference, ranks, and direct links.
- `MissingOwnSection` groups one signature per row and always renders the no-alert explanation; `OWN_OUT_OF_STOCK_ONLY` uses the distinct “我方有组合但当前无库存” label.

Use existing Ant Design icons and `Tooltip` for unfamiliar icon-only actions. Set explicit column widths and `scroll={{ x: 1280 }}` or greater for dense tables.

- [ ] **Step 6: Integrate sections without removing audit evidence**

Place the summary and three sections after run metadata and before positions/issues/audit SKUs. Empty sections render restrained empty states. A partial run keeps all captured rows but prominently shows incomplete coverage.

- [ ] **Step 7: Run web tests, type checks, and production build**

Run:

```bash
pnpm test:web
pnpm typecheck
pnpm --filter @stau-price-monitor/web build
git diff --check
```

Expected: all tests pass and the production build contains no type mismatch with the API response.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/web/src/api/types.ts apps/web/src/api/collection-runs.ts apps/web/src/api/collection-runs.test.ts apps/web/src/features/collection-runs/RunBusinessSummary.tsx apps/web/src/features/collection-runs/PriceBoardSection.tsx apps/web/src/features/collection-runs/ConfirmedLowsSection.tsx apps/web/src/features/collection-runs/MissingOwnSection.tsx apps/web/src/pages/CollectionRunDetailPage.tsx apps/web/src/pages/CollectionRunDetailPage.test.tsx apps/web/src/styles.css
git commit -m "feat: render first-50 SKU gap reports"
```

---

### Task 8: Format One WeCom Summary and Gate the First Live Send

**Files:**
- Modify: `apps/api/src/alerts/wecom/wecom-run-summary.ts`
- Modify: `apps/api/src/alerts/wecom/wecom-run-summary.spec.ts`
- Modify: `apps/api/src/alerts/run-alert-notifier.ts`
- Modify: `apps/api/src/alerts/run-alert-notifier.spec.ts`
- Modify: `apps/api/src/alerts/prisma-run-alert-notification.repository.ts`
- Create: `apps/api/src/alerts/run-alert-notification-approval.service.ts`
- Create: `apps/api/src/alerts/run-alert-notification-approval.service.spec.ts`
- Modify: `apps/api/src/settings/settings.service.ts`
- Modify: `apps/api/src/settings/settings.service.spec.ts`
- Modify: `apps/api/src/http/operations-collection-runs-http.controller.ts`
- Modify: `apps/api/src/http/operations-collection-runs-http.controller.spec.ts`
- Modify: `apps/api/src/runtime.ts`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/api/collection-runs.ts`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.tsx`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.test.tsx`

**Interfaces:**
- Produces: global setting `WECOM_LIVE_SEND_APPROVAL` containing approved flag, actor, timestamp, preview run ID, and preview digest.
- Produces: `RunAlertNotificationApprovalService.preview(runId)` and `.approve(input, actorId, role)`.
- Adds: `GET /operations/collection-runs/:runId/notification-preview`.
- Adds: `POST /operations/collection-runs/:runId/notification-confirm` with `{ previewDigest, confirmation: "SEND_TO_WECOM" }`.
- Guarantees: no batch is claimed while live sending is unapproved; after the first approved preview, future batches send normally.

- [ ] **Step 1: Add failing WeCom top-10 summary tests**

Create a summary with 12 confirmed lows and 12 missing groups. Assert the Markdown contains:

```ts
assert.match(markdown, /前50位置 50\/50/);
assert.match(markdown, /确认低价 12/);
assert.match(markdown, /缺失组合 12/);
assert.match(markdown, /人工复核 3/);
assert.equal((markdown.match(/同行低价/g) ?? []).length, 10);
assert.equal((markdown.match(/缺失组合：/g) ?? []).length, 10);
assert.match(markdown, /查看完整报告/);
assert.ok(Array.from(markdown).length <= 3_500);
```

Assert low rows sort by largest difference and missing groups sort by minimum confirmed price then rank.

- [ ] **Step 2: Add failing notifier gate and approval-service tests**

Test that `RunAlertNotifier.send(summary)` does not call `claimBatch` or the sender while approval is false. Then preview one stored batch, calculate a digest, reject a stale digest or wrong confirmation text, approve the exact preview as `ADMIN`, and assert:

```ts
assert.equal(settings.liveSendingApproved, true);
assert.equal(audit.entries[0]?.action, "wecom.live-send.approved");
assert.equal(sender.messages.length, 1);
```

An `OPERATOR` approval must fail. Repeating approval must not send the same batch twice.

- [ ] **Step 3: Run focused tests and verify the gate is absent**

Run:

```bash
node --test apps/api/src/alerts/wecom/wecom-run-summary.spec.ts apps/api/src/alerts/run-alert-notifier.spec.ts apps/api/src/alerts/run-alert-notification-approval.service.spec.ts apps/api/src/settings/settings.service.spec.ts
```

Expected: new summary fields, gate, and approval service do not exist.

- [ ] **Step 4: Format one bounded run summary**

The message order is fixed:

1. Model, Shanghai time, and `positions/searchLimit` completion.
2. Shop, item, SKU, confirmed-low, missing-group, review, and issue counts.
3. Up to 10 confirmed lows with rank, shop, combination, competitor price, actual selected own price, difference, and link.
4. Up to 10 missing groups with combination, shop count, minimum price, earliest rank, and representative link.
5. Full report link.

Never render a missing group as “low price”. Preserve the existing 3,500-code-point limit and safe URL/text handling.

- [ ] **Step 5: Add the one-time approval setting and notifier dependency**

In `SettingsService`, add:

```ts
async isWecomLiveSendingApproved(): Promise<boolean>;
async approveWecomLiveSending(
  input: { previewRunId: string; previewDigest: string },
  actorId: string,
  role: UserRole
): Promise<void>;
```

Persist non-secret JSON under `WECOM_LIVE_SEND_APPROVAL` and audit before/after state. Inject `isLiveSendingApproved: () => Promise<boolean>` into `RunAlertNotifier`; return before `claimBatch` when false.

- [ ] **Step 6: Implement preview digest and fresh confirmation**

The approval service reads the existing durable batch without claiming it, parses the stored summary, builds Markdown, and returns:

```ts
{
  runId,
  state,
  markdown,
  previewDigest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
  liveSendingApproved
}
```

`approve` requires exact confirmation text and an equal current digest, records approval, then calls the notifier for that stored summary. The webhook stays inside the existing encrypted secret path.

- [ ] **Step 7: Add authenticated HTTP endpoints and UI preview**

Require `ADMIN` for confirmation; preview remains under the existing `ADMIN` operations controller. On the run detail page, display a “预览企业微信消息” action when a batch exists. The modal shows the stored Markdown and a prominent “确认发送并启用后续自动提醒” button; it posts the current digest and exact confirmation token.

Do not optimistically mark sent. Refetch the run and preview after the API succeeds.

- [ ] **Step 8: Run API, web, and idempotency tests**

Run:

```bash
pnpm test:api
pnpm test:web
pnpm typecheck
git diff --check
```

Expected: unapproved batches remain durable and unsent, approval sends one stored batch, later runs can send automatically, and no retry duplicates a notified batch.

- [ ] **Step 9: Commit Task 8**

```bash
git add apps/api/src/alerts/wecom/wecom-run-summary.ts apps/api/src/alerts/wecom/wecom-run-summary.spec.ts apps/api/src/alerts/run-alert-notifier.ts apps/api/src/alerts/run-alert-notifier.spec.ts apps/api/src/alerts/prisma-run-alert-notification.repository.ts apps/api/src/alerts/run-alert-notification-approval.service.ts apps/api/src/alerts/run-alert-notification-approval.service.spec.ts apps/api/src/settings/settings.service.ts apps/api/src/settings/settings.service.spec.ts apps/api/src/http/operations-collection-runs-http.controller.ts apps/api/src/http/operations-collection-runs-http.controller.spec.ts apps/api/src/runtime.ts apps/web/src/api/types.ts apps/web/src/api/collection-runs.ts apps/web/src/pages/CollectionRunDetailPage.tsx apps/web/src/pages/CollectionRunDetailPage.test.tsx
git commit -m "feat: gate and summarize WeCom run notifications"
```

---

### Task 9: Verify the Full Workflow and Document Operations

**Files:**
- Create: `tests/e2e/desktop-sku-combination-report.spec.ts`
- Create: `tests/e2e/support/desktop-report-harness.ts`
- Modify: `tests/e2e/support/monitor-harness.ts`
- Modify: `docs/operations/macos-collector.md`
- Modify: `docs/operations/operator-guide.md`

**Interfaces:**
- Produces: a portable fixture-based end-to-end proof for multi-own baselines, one-fen lows, missing combinations, report projections, and a durable unsent notification batch.
- Produces: operator instructions for configuring all own links, reading the three report sections, reviewing incomplete runs, and approving the first live WeCom send.

- [ ] **Step 1: Add a failing end-to-end scenario**

Extend the harness with desktop snapshot/component fixtures and add:

```ts
test("builds one-fen lows and missing groups from exact SKU combinations", async () => {
  const harness = await createMonitorHarness({ wecomLiveSendingApproved: false });
  const run = await harness.collectDesktopCombinationRun({
    own: [
      { itemId: "own-a", skuId: "single-high", payableFen: 148_001, components: [nt1sCore] },
      { itemId: "own-b", skuId: "single-low", payableFen: 148_000, components: [nt1sCore] }
    ],
    competitors: [
      { itemId: "competitor-low", skuId: "single", payableFen: 147_999, components: [nt1sCore], ranks: [1, 4] },
      { itemId: "competitor-bundle", skuId: "ai1", payableFen: 188_000, components: [nt1sCore, ai1Accessory], ranks: [2] }
    ]
  });

  assert.equal(run.report.confirmedLows[0]?.differenceFen, 1);
  assert.equal(run.report.confirmedLows[0]?.selectedOwnSnapshot.id, "single-low");
  assert.deepEqual(run.report.confirmedLows[0]?.ranks, [1, 4]);
  assert.equal(run.report.missingOwnGroups.length, 1);
  assert.equal(run.alerts.length, 1);
  assert.equal(run.notificationBatch.state, "PENDING");
  assert.equal(run.sentMessages.length, 0);
});
```

- [ ] **Step 2: Run the new end-to-end test and verify harness support is absent**

Run:

```bash
node --test --test-concurrency=1 tests/e2e/desktop-sku-combination-report.spec.ts
```

Expected: `collectDesktopCombinationRun` is missing.

- [ ] **Step 3: Implement the minimal fixture harness path**

Reuse real contract parsing, desktop report ingestion service, run alert service, combination evaluator, and report aggregation. Use focused in-memory repositories so this test stays portable; Prisma persistence remains covered by Tasks 2, 5, and 6 integration tests. Stub only Taobao UI interaction, persistence adapters, and the WeCom sender. The harness must not duplicate combination or price logic.

Update the existing manual-provider harness only as required by the new `AlertOffer.combinationSignature` and summary fields; give legacy fixture offers deterministic valid signatures:

```ts
const signature = `sku-combination-v1:${createHash("sha256")
  .update(`legacy:${model.monitorCode}`)
  .digest("hex")}`;
```

This keeps the older acceptance scenarios meaningful without introducing a second signature format.

- [ ] **Step 4: Update operator documentation**

Document these exact operating rules:

- Register every active own product link for the monitored model before trusting missing-combination results.
- Keep Taobao Desktop logged in and the intended window frontmost during collection.
- A `50/50` or verified end marker is complete; any other lower count is partial.
- “确认低价同行” is safe for manual repricing review; “我方缺失组合” is assortment information only.
- Review `OWN_CATALOG_INCOMPLETE`, unknown components, unstable prices, and legacy rows manually.
- Preview and confirm the first real WeCom message from one completed run; later batches send automatically.
- The system never changes prices automatically.

- [ ] **Step 5: Run the full portable verification suite**

Run:

```bash
pnpm verify:portable
pnpm test:e2e
swift test --package-path apps/collector-macos
pnpm audit:public
git diff --check
```

Expected: every command passes with no real Taobao account and no real WeCom delivery.

- [ ] **Step 6: Run browser visual verification**

Start the local API and web app with fixture data, then verify the run detail at desktop and narrow widths. Capture screenshots outside Git and confirm:

- summary counts match fixture facts;
- all three sections render;
- duplicate ranks remain visible;
- tables scroll horizontally without overlap or clipping;
- full links and expansion controls work;
- notification preview opens but does not send.

- [ ] **Step 7: Commit Task 9**

```bash
git add tests/e2e/desktop-sku-combination-report.spec.ts tests/e2e/support/desktop-report-harness.ts tests/e2e/support/monitor-harness.ts docs/operations/macos-collector.md docs/operations/operator-guide.md
git commit -m "test: verify first-50 SKU gap workflow"
```

---

## User-Supervised Live Acceptance

Begin only after the macOS focused-window plan is complete and all automated verification above passes.

- [ ] Keep the real WeCom live-send gate disabled. Confirm Taobao Desktop is logged in and version diagnostics are healthy.

- [ ] Collect the first 3 positions for `Sony MDR-7506`. Verify every visible SKU, activity, stock, component role, and full link against the desktop page.

- [ ] Confirm the rule example: a same-combination competitor at `¥589.00` against our `¥610.00` appears as lower by `¥21.00`. Treat these values as a test observation, not a permanent market price.

- [ ] Collect the first 3 positions for `RODE NT1S`. Confirm a same-combination `¥1480.00` competitor against our `¥1480.00` does not alert, and a `RODE NT1` `¥1385.00` result is excluded as the wrong model.

- [ ] Inspect every `UNKNOWN`, estimated price, unstable price, and missing-own result. Correct parser rules only from visible evidence; do not weaken review gates.

- [ ] Run complete first-50 collection for both models. Accept fewer than 50 only with a verified end marker.

- [ ] Compare report shop counts, unique item counts, duplicate ranks, all SKU rows, confirmed lows, and missing groups with the captured desktop evidence.

- [ ] Open the stored WeCom preview. After the user gives a fresh confirmation in that operation, send one real test summary and verify the group receives exactly one message with top-10 sections and the report link.

- [ ] Confirm no store price changed and no login, CAPTCHA, or challenge was bypassed.
