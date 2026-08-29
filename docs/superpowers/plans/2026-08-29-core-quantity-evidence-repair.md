# Core Quantity Evidence Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve explicit quantities on recognized core-product SKU labels and force review when explicit core quantities conflict.

**Architecture:** Keep quantity interpretation at the collector evidence boundary. Extend the private token parser to distinguish an implicit default quantity from written quantity evidence, then route every recognized core token through one conflict-safe assignment helper. The public collector contract and API combination builder remain unchanged.

**Tech Stack:** TypeScript, Node.js test runner, pnpm workspace.

## Global Constraints

- Modify only `apps/collector/src/core/sku-component-evidence.ts` and `apps/collector/src/core/sku-component-evidence.spec.ts` for production behavior and regression coverage.
- Follow strict TDD: focused tests must be observed failing for the expected reason before production code changes.
- `单机2件`, `裸机2件`, `单品3个`, and `单麦克风2只` must preserve their explicit core quantities.
- Bare aliases without written quantities keep the default core quantity of `1`.
- Conflicting explicit core quantities add `UNKNOWN` so downstream comparison becomes `REVIEW`.
- Equivalent repeated explicit quantities remain valid and do not add `UNKNOWN`.
- Do not change exact-combination signatures, the one-fen threshold, reports, database schema, or Enterprise WeChat live-send controls.
- Do not perform live Taobao collection or send a live Enterprise WeChat message.

---

### Task 1: Repair Core Quantity Evidence

**Files:**
- Modify: `apps/collector/src/core/sku-component-evidence.ts:46-63,160-210`
- Test: `apps/collector/src/core/sku-component-evidence.spec.ts`

**Interfaces:**
- Consumes: `deriveSkuComponents(input: SkuComponentEvidenceInput): CollectedSkuComponent[]`.
- Produces: unchanged public output type; the private valid result of `componentTokenQuantity` additionally records whether its quantity came from explicit token text.

- [ ] **Step 1: Add focused regression tests before changing production code**

Add real-behavior tests equivalent to the following cases:

```typescript
test("preserves explicit core quantity on recognized single-product aliases", () => {
  for (const [label, expectedQuantity] of [
    ["单机2件", 2],
    ["裸机2件", 2],
    ["单品3个", 3],
    ["单麦克风2只", 2]
  ] as const) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.find((item) => item.role === "CORE")?.quantity, expectedQuantity, label);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), false, label);
  }
});

test("marks conflicting explicit core quantities unknown", () => {
  for (const label of ["NT1S2件/单机3件", "NT1S2件/单机1件"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.some((item) => item.role === "UNKNOWN"), true, label);
  }
});

test("accepts equivalent explicit core quantities and ignores implicit alias counts", () => {
  for (const label of ["单机2件/NT1S2件", "NT1S2件/单机"]) {
    const result = deriveSkuComponents({
      brand: "RODE",
      standardModel: "NT1S",
      selectedLabels: { "套餐类型": label },
      explicitComponents: undefined
    });

    assert.equal(result.find((item) => item.role === "CORE")?.quantity, 2, label);
    assert.equal(result.some((item) => item.role === "UNKNOWN"), false, label);
  }
});
```

- [ ] **Step 2: Run the focused test file and verify RED**

Run:

```bash
node --test apps/collector/src/core/sku-component-evidence.spec.ts
```

Expected: the alias-quantity and conflicting-quantity assertions fail because aliases currently discard their explicit quantity. Existing tests remain runnable; a loader or syntax error is not an acceptable red result.

- [ ] **Step 3: Implement the minimal conflict-safe parser change**

Change only the private parser and core-token branches:

```typescript
function componentTokenQuantity(rawToken: string):
  | { kind: "VALID"; token: string; quantity: number; quantityIsExplicit: boolean }
  | { kind: "INVALID" } {
  // No quantity evidence returns quantity 1 with quantityIsExplicit: false.
  // One valid trailing quantity returns quantityIsExplicit: true.
}
```

Add one small helper that applies a core quantity only when the evidence is explicit. If the core is still at its default or already has the same quantity, assign/retain it. If a different explicit quantity was already assigned, append `unknownQuantity(dimension, label)` and retain the first explicit quantity.

Use that helper for:

- tokens equal to `standardModel`;
- tokens in `SINGLE_PRODUCT_LABELS`;
- joined model-plus-core-descriptor evidence such as `NT1S麦克风2件`.

Do not treat an implicit quantity of `1` as contradictory evidence.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test apps/collector/src/core/sku-component-evidence.spec.ts
```

Expected: all focused component-evidence tests pass with no warnings or errors.

- [ ] **Step 5: Run all collector tests**

Run:

```bash
pnpm test:collector
```

Expected: all collector tests pass.

- [ ] **Step 6: Run repository verification**

Run:

```bash
pnpm verify
pnpm audit:public
git diff --check
```

Expected: all commands pass. The existing non-failing Vite large-chunk warning is allowed; no new warning is allowed.

- [ ] **Step 7: Commit the focused repair**

```bash
git add apps/collector/src/core/sku-component-evidence.ts apps/collector/src/core/sku-component-evidence.spec.ts
git commit -m "fix: preserve explicit core SKU quantities"
```
