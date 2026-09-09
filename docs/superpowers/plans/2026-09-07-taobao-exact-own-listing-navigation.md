# Taobao Exact Own Listing Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live Taobao searches submit reliably and ensure the collector opens only the configured own listing before enumerating Babyface SKUs.

**Architecture:** Preserve the guarded native text replacement and post-action stability checks, but submit through the unique profiled search button. Pass the model query into own-listing navigation, search up to 50 results, and select the earliest exact item-ID match. Normalize omitted nullable AX fields at the helper boundary, keep selectors defensive, and revalidate desktop readiness on every checkpoint retry.

**Tech Stack:** TypeScript, Node.js 24, `node:test`, macOS Accessibility helper, pnpm workspace.

## Global Constraints

- Support only Taobao Desktop `2.4.5` build `15` for live collection.
- Never use direct URL injection, clipboard input, coordinate clicks, CAPTCHA handling, automatic repricing, or Enterprise WeChat delivery.
- Preserve login, challenge, item-identity, shop-binding, and three-observation stability gates.
- Revalidate front-window and logged-in state before every non-complete run attempt.
- Failed own-baseline collection must produce no low-price conclusion.

---

### Task 1: Submit Live Searches Through the Verified Button

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Test: `apps/collector/src/drivers/macos/taobao-selectors.spec.ts`
- Test: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`

**Interfaces:**
- Produces: `findSearchSubmitAction(root): { node: AxNode; action: "AXConfirm" | "AXPress" }`.
- Consumes: existing `replaceText`, `setValue`, `fingerprintFor`, and stable-result checks.

- [ ] **Step 1: Write failing selector and driver tests**

```ts
const submit = findSearchSubmitAction(liveSearchRoot);
assert.equal(submit.action, "AXPress");
assert.equal(axNodeText(submit.node), "搜索");

await driver.search("RME Babyface", 1);
assert.deepEqual(client.commands.slice(0, 3).map((entry) => entry.command), [
  "activate", "replaceText", "perform"
]);
assert.equal(client.commands.some((entry) => entry.command === "keyPress"), false);
```

Also reject duplicate, disabled, non-button, and non-`AXPress` live submit candidates.

- [ ] **Step 2: Run the focused tests and verify the new cases fail**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: failures show the live submit selector is absent and the driver still sends key code `36`.

- [ ] **Step 3: Restore a profiled live submit selector and use it after native replacement**

```ts
export function liveFindSearchSubmitButton(root: AxNode): AxNode {
  const candidates = walkAxNodes(uniqueSearchWebArea(root)).filter((node) =>
    node.role === "AXButton" && normalizeText(axNodeText(node) ?? "") === "搜索");
  if (candidates.length !== 1) return profileError();
  const button = candidates[0] ?? profileError();
  if (button.enabled !== true || !button.actions.includes("AXPress")) return profileError();
  return button;
}
```

After the existing post-write value check, resolve `findSearchSubmitAction(postWrite)` and invoke its fingerprinted action for both profiles. Remove the live Return-key branch only; keep native `replaceText`.

- [ ] **Step 4: Run the focused tests and commit**

Expected: all focused selector and live-driver tests pass.

```bash
git add apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/*selectors.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
git commit -m "fix: submit live Taobao searches reliably"
```

### Task 2: Select the Own Listing by Exact Identity

**Files:**
- Modify: `apps/collector/src/core/desktop-driver.ts`
- Modify: `apps/collector/src/core/collection-runner.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Test: `apps/collector/src/core/collection-runner.spec.ts`
- Test: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`

**Interfaces:**
- Produces: `openOwnListing(url: string, searchQuery: string): Promise<DriverItemPage>`.
- Consumes: `CollectorJob.searchQuery`, `canonicalItemIdentity`, `search(query, 50)`, and `openSearchPosition`.

- [ ] **Step 1: Write failing exact-selection tests**

```ts
const page = await driver.openOwnListing(
  "https://item.taobao.com/item.htm?id=own-2",
  "RME Babyface"
);
assert.equal(page.platformItemId, "own-2");
assert.equal(openedRank, 7);
```

The fixture must place an unrelated item first, the exact own item at rank 7,
and the same exact item again later. Assert the earliest exact occurrence is
opened. Add a zero-match case that rejects before any item action.

In the runner test, capture both arguments and assert the second argument is
`job.searchQuery`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/core/collection-runner.spec.ts
```

Expected: the driver opens rank 1 and the runner does not forward the model query.

- [ ] **Step 3: Implement exact own-item selection**

```ts
async openOwnListing(url: string, searchQuery: string): Promise<DriverItemPage> {
  const expected = canonicalItemIdentity(url);
  if (!expected.platformItemId) throw new MissingItemIdError();
  const result = await this.search(searchQuery, 50);
  const position = result.positions.find((candidate) =>
    candidate.platformItemId === expected.platformItemId);
  if (!position) throw new UiContractChangedError(
    "Taobao did not expose the configured own listing in the first 50 results."
  );
  const page = await this.openSearchPosition(position);
  if (page.platformItemId !== expected.platformItemId) {
    throw new UiContractChangedError("Taobao opened a different own listing.");
  }
  return page;
}
```

Update the interface and call `this.driver.openOwnListing(listing.url, job.searchQuery)`.

- [ ] **Step 4: Run focused tests, typecheck, and commit**

```bash
pnpm --filter @stau-price-monitor/collector typecheck
git add apps/collector/src/core/desktop-driver.ts apps/collector/src/core/collection-runner.ts apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/core/collection-runner.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
git commit -m "fix: open the exact configured own listing"
```

### Task 3: Normalize Omitted AX Nullable Fields

**Files:**
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Test: `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`

**Interfaces:**
- Produces: normalized `AxNode` snapshots whose nullable scalar fields are explicitly `null`.
- Consumes: existing helper response transport and `UiContractChangedError`.

- [ ] **Step 1: Write failing normalization and selector tests**

```ts
const snapshot = await client.snapshot();
assert.equal(snapshot.title, null);
assert.equal(snapshot.value, null);
assert.equal(snapshot.children[0]?.description, null);

assert.doesNotThrow(() => liveFindBackAction(rootWithOmittedTitles, "RME Babyface"));
```

The selector fixture must include unrelated pressable nodes with omitted
`title` and `value`, plus exactly one verified `返回` control.

- [ ] **Step 2: Run focused tests and verify the missing fields reproduce the failure**

Run:

```bash
node --test apps/collector/src/drivers/macos/ax-helper-client.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: snapshot fields remain `undefined` and back selection throws a `TypeError`.

- [ ] **Step 3: Normalize recursively and add defensive string guards**

```ts
function normalizeSnapshotNode(node: AxNode): AxNode {
  if (!Array.isArray(node.children)) {
    throw new UiContractChangedError("Taobao Accessibility helper emitted an invalid snapshot.");
  }
  return {
    ...node,
    role: node.role ?? null,
    subrole: node.subrole ?? null,
    identifier: node.identifier ?? null,
    title: node.title ?? null,
    description: node.description ?? null,
    value: node.value ?? null,
    url: node.url ?? null,
    enabled: node.enabled ?? null,
    selected: node.selected ?? null,
    position: node.position ?? null,
    size: node.size ?? null,
    children: node.children.map(normalizeSnapshotNode)
  };
}
```

Use `typeof value === "string"` in `liveFindBackAction` before normalization.

- [ ] **Step 4: Run focused tests and commit**

```bash
git add apps/collector/src/drivers/macos/ax-helper-client.ts apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/ax-helper-client.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
git commit -m "fix: normalize live Taobao snapshots"
```

### Task 4: Revalidate Desktop Readiness on Every Retry

**Files:**
- Modify: `apps/collector/src/core/collection-runner.ts`
- Test: `apps/collector/src/core/collection-runner.spec.ts`

**Interfaces:**
- Produces: a per-attempt readiness gate before any phase accesses Taobao.
- Consumes: existing `driver.diagnose()`, checkpoint resume, and typed pause or
  driver issues.

- [ ] **Step 1: Write a failing resume-readiness test**

```ts
const first = await runner.run(job, job.collectorId);
assert.equal(first.status, "FAILED");
assert.equal(first.issues.some((entry) => entry.code === "TAOBAO_NOT_FRONTMOST"), true);

const resumed = await runner.run(job, job.collectorId);
assert.equal(diagnosticCalls, 2);
assert.equal(pageAccessStartedAfterSecondDiagnostic, true);
assert.equal(resumed.issues.some((entry) => entry.code === "TAOBAO_NOT_FRONTMOST"), false);
```

Also keep the second attempt blocked when its diagnostic still reports no
front window, and assert page methods are never called in that case.

- [ ] **Step 2: Run the runner tests and verify the resume case fails**

```bash
node --test apps/collector/src/core/collection-runner.spec.ts
```

Expected: the second invocation reports only one diagnostic call or begins page access without a fresh diagnostic.

- [ ] **Step 3: Move readiness outside the fresh-checkpoint branch**

Run `driver.diagnose()` for every non-complete attempt, update the report app
version, enforce `hasFrontWindow` and `LOGGED_IN`, then save the checkpoint.
Before the attempt, remove stale `LOGIN_REQUIRED`, `PLATFORM_CHALLENGE`,
`MISSING_ITEM_ID`, and `TAOBAO_NOT_FRONTMOST` issues plus the existing pause
boundary message. Preserve all unrelated issues.

- [ ] **Step 4: Run runner tests and commit**

```bash
git add apps/collector/src/core/collection-runner.ts apps/collector/src/core/collection-runner.spec.ts
git commit -m "fix: revalidate collector readiness on resume"
```

### Task 5: Verify and Run the Babyface Pilot

**Files:**
- Inspect only: the active run checkpoint under `work/collector-runs/`
- Inspect only: API run and report endpoints

**Interfaces:**
- Consumes: the three fixed collector behaviors and the existing three-position Babyface run configuration.
- Produces: verified run status, own SKU evidence, competitor SKU evidence, and a remaining-risk list.

- [ ] **Step 1: Run collector verification**

```bash
pnpm --filter @stau-price-monitor/collector test
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: all collector tests pass, type checking passes, and no whitespace errors exist.

- [ ] **Step 2: Run one supervised three-position live pilot**

```bash
pnpm collector:diagnose
pnpm collector:once
```

Expected: the own page is the configured Babyface listing. The run either
completes all own and competitor SKUs or stops with a specific typed issue.

- [ ] **Step 3: Inspect persisted evidence before drawing conclusions**

Confirm that every comparable row has exact model matching, stock state,
selected SKU labels, confirmed or explicitly estimated payable price, own
baseline binding, and evidence reference. Treat search-card prices such as
deposits or accessory variants as non-conclusive until SKU evidence confirms
them.

- [ ] **Step 4: Run repository verification and record residual risks**

```bash
pnpm test:collector
pnpm typecheck
pnpm audit:public
```

Report any public-audit/documentation failures separately from collector logic,
and do not claim full completion while any required verification is red.
