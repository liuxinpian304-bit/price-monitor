# Taobao Page-Aware Search Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Taobao Desktop collector traverse verified result pages and deterministically reopen any captured rank in the first 50 results.

**Architecture:** Add a strict pagination parser at the selector boundary, expose typed forward and backward search movements, and include page state in the driver's stable context. The driver appends complete pages across page transitions, rewinds through verified previous controls before rank replay, and preserves the existing scroll fallback when no pagination contract exists.

**Tech Stack:** TypeScript, Node.js test runner, macOS Accessibility helper, pnpm workspace.

## Global Constraints

- Support only Taobao Desktop `2.4.5` build `15`.
- Mutate only raw AX nodes selected from the latest snapshot and include `fingerprintFor(node)`.
- Never use coordinates, direct item URL injection, CAPTCHA automation, automatic repricing, or Enterprise WeChat delivery.
- Fail closed with `UiContractChangedError` for ambiguous, contradictory, disabled, stale, or non-progressing pagination.
- Preserve the current infinite-scroll `AXScrollDown` and Page Down fallback when strict pagination is absent.
- Apply TDD: every production behavior begins with a focused failing test whose failure is observed.

---

### Task 1: Strict Live Pagination Selectors

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-selector-contract.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`

**Interfaces:**
- Produces: `SearchPaginationState { currentPage: number; totalPages: number }`.
- Produces: `SearchAdvance`, extended to support fingerprinted `AXPress` as well as `AXScrollDown` and Page Down.
- Produces: `SearchRetreat`, supporting fingerprinted previous-page `AXPress` or Home.
- Produces: `readSearchPaginationState(root): SearchPaginationState | null` and `readSearchRetreat(root): SearchRetreat`.
- Consumes: `AxNode`, `axNodeText`, `walkAxNodes`, and the existing live search web-area contract.

- [ ] **Step 1: Write failing strict-pagination tests**

Add a test helper that appends a realistic `next-pagination-pages` group to a cloned live search fixture. Assert this public selector behavior:

```ts
const pageOne = withLivePagination(await fixture("live-search-results.json"), 1, 2);
assert.deepEqual(readSearchPaginationState(pageOne), { currentPage: 1, totalPages: 2 });
assert.deepEqual(readSearchAdvance(pageOne), {
  kind: "AX_ACTION",
  action: "AXPress",
  node: expectedNextButton(pageOne)
});
assert.deepEqual(readSearchRetreat(pageOne), { kind: "KEY", keyCode: 115 });
assert.equal(hasSearchEndMarker(pageOne), false);

const pageTwo = withLivePagination(await fixture("live-search-results-next.json"), 2, 2);
assert.equal(hasSearchEndMarker(pageTwo), true);
assert.deepEqual(readSearchRetreat(pageTwo), {
  kind: "AX_ACTION",
  action: "AXPress",
  node: expectedPreviousButton(pageTwo)
});
```

Add table cases that reject duplicate pagination groups, mismatched display values, a disabled next button before the final page, a missing `AXPress`, and a control description whose current page differs from the parsed state.

- [ ] **Step 2: Run the selector test and observe RED**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: FAIL because `readSearchPaginationState` and `readSearchRetreat` are not exported and `SearchAdvance` does not accept `AXPress`.

- [ ] **Step 3: Implement the minimal strict parser and movement selectors**

Add the typed contracts:

```ts
export interface SearchPaginationState {
  currentPage: number;
  totalPages: number;
}

export type SearchAdvance =
  | { kind: "AX_ACTION"; action: "AXScrollDown" | "AXPress"; node: AxNode }
  | { kind: "KEY"; keyCode: 121 };

export type SearchRetreat =
  | { kind: "AX_ACTION"; action: "AXPress"; node: AxNode }
  | { kind: "KEY"; keyCode: 115 };
```

Within the unique live search web area, parse exactly one group carrying
`next-pagination-pages`. Require one current button matching
`/^第(\\d+)页，共(\\d+)页$/`, one `next-pagination-display` containing exactly
the same `current`, `/`, and `total` values, and direct previous/next buttons
whose class lists and descriptions match that state. Return `null` only when no
pagination group exists; any partial or ambiguous pagination throws the profile
error. Prefer next-page `AXPress`, return previous-page `AXPress` when
`currentPage > 1`, and use the existing keyboard fallbacks only outside an
actionable page transition.

- [ ] **Step 4: Run selector tests and observe GREEN**

Run the focused command from Step 2. Expected: all live selector tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/collector/src/drivers/macos/taobao-selector-contract.ts apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
git commit -m "fix: parse live Taobao result pagination"
```

### Task 2: Page-Aware Collection And Rank Replay

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Test: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`

**Interfaces:**
- Consumes: `readSearchPaginationState(root)` and `readSearchRetreat(root)` from Task 1.
- Preserves: `search(query, limit): Promise<DriverSearchResult>` and `openSearchPosition(position): Promise<DriverItemPage>`.
- Produces internally: page-aware search contexts and a bounded rewind-to-top operation.

- [ ] **Step 1: Write failing page-boundary and replay tests**

Create paginated page-one and page-two variants of the existing live fixtures.
Assert that a three-position search presses the raw next button and preserves
the first card on page two as global rank three, even when it duplicates page
one semantically:

```ts
assert.deepEqual(result.positions.map(({ rank, platformItemId }) => ({ rank, platformItemId })), [
  { rank: 1, platformItemId: "example-x1-a" },
  { rank: 2, platformItemId: "example-x1-a" },
  { rank: 3, platformItemId: "example-x1-a" }
]);
assert.equal(client.commands.some(({ command, fields }) =>
  command === "perform" && fields.action === "AXPress"
    && Array.isArray(fields.fingerprint?.domClassList)
    && fields.fingerprint.domClassList.includes("next-next")), true);
```

Add one test opening rank one after search ended on page two. It must press the
verified previous button, restore the exact first-page signature, then press
the rank-one link without Home. Add another test opening rank three: it must
rewind to page one, press verified next, rebuild ranks, and press page two's
first raw link. Add non-progress and 50-movement-bound rejection cases.

- [ ] **Step 2: Run the live driver test and observe RED**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: FAIL because page state is absent from the stable context, cross-page
duplicates are overlap-merged, and replay still uses Home.

- [ ] **Step 3: Implement page-aware stable contexts and accumulation**

Extend `SearchContext` with `pagination: SearchPaginationState | null` and add
`[pagination?.currentPage, pagination?.totalPages]` to its signature. When both
stable contexts have pagination and the page number changes, merge with:

```ts
const merged = [...cards, ...next];
```

Otherwise retain `mergeSearchCardViewports(cards, next, viewportCards)`. Verify
that every requested transition changes either page state or the existing
strict viewport signature before accepting it.

- [ ] **Step 4: Implement bounded page-aware rewind and replay**

Replace the unconditional Home branch in `locateCard` with a helper that:

```ts
while (readSearchContext(current).signature !== this.currentSearchTopContextSignature) {
  if (movementCount === 50) throw new UiContractChangedError("Taobao search could not restore the first result page.");
  const before = readSearchContext(current).signature;
  const retreat = readSearchRetreat(current);
  await this.performSearchMovement(retreat);
  movementCount += 1;
  current = retreat.kind === "KEY"
    ? await this.waitForStableSearchReturn(this.currentSearchQuery, this.currentSearchTopContextSignature)
    : await this.waitForStableSearch(this.currentSearchQuery, before);
}
```

Use one shared mutation helper for forward and backward movements so every AX
action carries the latest node path and fingerprint. During forward replay,
apply the same page-aware append rule used by `search` before checking the
global rank.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run the live driver command from Step 2, then:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
```

Expected: all focused selector and driver tests pass, including the unchanged
scroll and Page Down fallback tests.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
git commit -m "fix: replay paginated Taobao search ranks"
```

### Task 3: Verification And Real Babyface Pilot

**Files:**
- Modify: `.superpowers/sdd/2026-09-07-taobao-exact-own-listing-navigation/progress.md`

**Interfaces:**
- Consumes: completed Tasks 1 and 2 plus the existing collector worker and API.
- Produces: verified test evidence and one real three-position Babyface run report.

- [ ] **Step 1: Run complete static verification**

```bash
node scripts/run-collector-tests.mjs
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: 100% collector tests pass, type checking exits zero, and diff check is
silent.

- [ ] **Step 2: Run a fresh real three-position job**

Activate bundle ID `com.taobao.pcdesktop`, run `collector diagnose`, enqueue or
retry the `RME Babyface` job with `searchLimit: 3`, and run one collector job.
Do not enable Enterprise WeChat delivery.

- [ ] **Step 3: Inspect the authenticated report**

Read the run report through the admin API and record:

- whether the configured own listing and own shop binding completed;
- all collected own and competitor SKU combinations and evidence status;
- the exact effective-price basis used for each comparison;
- every blocking or non-blocking issue;
- whether any competitor is genuinely lower than the own comparable SKU.

Do not infer a low-price result from search-card teaser prices.

- [ ] **Step 4: Update the progress ledger and commit verification notes**

Mark the page-aware fix tasks complete. Record the exact test counts and real
run ID. If the run fails at a later boundary, leave the pilot task in progress
and record the new evidence-backed blocker rather than claiming completion.

```bash
git add .superpowers/sdd/2026-09-07-taobao-exact-own-listing-navigation/progress.md
git commit -m "docs: record page-aware Babyface verification"
```
