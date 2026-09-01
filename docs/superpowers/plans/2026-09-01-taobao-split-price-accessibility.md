# Taobao Split-Price Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse the verified Taobao Desktop split-price accessibility shape while rejecting every other ambiguous multi-price card.

**Architecture:** Keep the existing `priceRange(text)` path for one distinct numeric text. Add one focused node-aware resolver in `taobao-live-selectors.ts` that accepts exactly two uniquely exposed integer components only when strict role, digit, currency, position, containment, and rightmost-tail checks all pass; `cardEvidence` then consumes one resolved price pair without changing shop or scope logic.

**Tech Stack:** TypeScript, Node.js test runner, macOS Accessibility helper, Swift Package Manager.

## Global Constraints

- The existing single distinct price-text path remains authoritative and unchanged.
- The split fallback runs only for exactly two distinct numeric texts.
- Each numeric text must map to exactly one enabled `AXStaticText` node with non-null position and size.
- The major component must match `^[1-9]\\d{1,7}$`; the fractional tail must match `^\\d{1,2}$`, be below 100, and be shorter than the major component.
- The tail must be after the major node, within 20 vertical points, fully contained by the major frame, and centered in the rightmost quarter of the major frame.
- Exactly one enabled `¥` or `￥` node with position data must appear left of the major node, within 20 vertical points and 120 horizontal points.
- A one-digit tail appends one zero; a two-digit tail remains unchanged; the returned minimum and maximum prices are identical fixed two-decimal strings.
- Missing geometry, duplicate nodes, wrong roles, missing/multiple currency symbols, reversed/separated/non-contained/non-rightmost layout, unsupported digits, or a third numeric text fails closed.
- Do not skip unresolved cards or choose by order, magnitude, or first value.
- Do not alter shop resolution, evidence isolation, ancestor traversal, duplicate handling, rank, sponsored detection, stability timing, or mutations.
- Do not start API/collection lifecycle, queue, persistence, database, Enterprise WeChat, notification, or repricing actions.
- Live reporting contains only counts, termination reasons, booleans, and supported-link counts; never print titles, shops, URLs, prices, query text, raw accessibility content, credentials, or environment values.

---

### Task 1: Resolve The Strict Split-Price Shape

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts:91-161`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts:45-80,350-520`

**Interfaces:**
- Consumes: the existing card evidence `AxNode[]` and existing `priceRange(text)` parser.
- Produces: `cardPriceRange(nodes: AxNode[]): [string, string] | null`, used only by `cardEvidence`.

- [ ] **Step 1: Add deterministic test helpers for split-price geometry**

Add a helper beside the existing card helpers in
`taobao-live-selectors.spec.ts`:

```typescript
interface SplitPriceOptions {
  major?: string;
  fraction?: string;
  currencyCount?: number;
  majorRole?: string;
  fractionRole?: string;
  majorPosition?: { x: number; y: number } | null;
  majorSize?: { width: number; height: number } | null;
  fractionPosition?: { x: number; y: number } | null;
  fractionSize?: { width: number; height: number } | null;
  duplicateMajor?: boolean;
  thirdNumeric?: string | null;
}

function replaceFirstCardPriceWithSplit(
  root: AxNode,
  options: SplitPriceOptions = {}
): void {
  const scope = firstCardScope(root);
  const priceIndex = scope.children.findIndex((node) => node.description === "价格");
  assert.notEqual(priceIndex, -1);
  const major = options.major ?? "4999";
  const fraction = options.fraction ?? "9";
  const currencyCount = options.currencyCount ?? 1;
  const majorNode = axNode([...scope.path, priceIndex], {
    role: options.majorRole ?? "AXStaticText",
    value: major,
    enabled: true,
    position: options.majorPosition === undefined ? { x: 120, y: 100 } : options.majorPosition,
    size: options.majorSize === undefined ? { width: 100, height: 20 } : options.majorSize
  });
  const fractionNode = axNode([...scope.path, priceIndex + 1], {
    role: options.fractionRole ?? "AXStaticText",
    value: fraction,
    enabled: true,
    position: options.fractionPosition === undefined ? { x: 195, y: 100 } : options.fractionPosition,
    size: options.fractionSize === undefined ? { width: 10, height: 20 } : options.fractionSize
  });
  const replacements: AxNode[] = [
    ...Array.from({ length: currencyCount }, (_, index) => axNode([...scope.path, priceIndex + index + 2], {
      role: "AXStaticText",
      value: index === 0 ? "¥" : "￥",
      enabled: true,
      position: { x: 100 - index * 10, y: 100 },
      size: { width: 10, height: 20 }
    })),
    majorNode,
    fractionNode
  ];
  if (options.duplicateMajor) replacements.push(structuredClone(majorNode));
  if (options.thirdNumeric) replacements.push(axNode([...scope.path, priceIndex + replacements.length], {
    role: "AXStaticText",
    value: options.thirdNumeric,
    enabled: true,
    position: { x: 250, y: 100 },
    size: { width: 20, height: 20 }
  }));
  scope.children.splice(priceIndex, 1, ...replacements);
}
```

- [ ] **Step 2: Write the successful split-price tests**

Add:

```typescript
test("combines a strict one-digit split-price tail", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithSplit(root);

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "4999.90");
  assert.equal(card?.displayPriceMaxText, "4999.90");
});

test("preserves a strict two-digit split-price tail", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  replaceFirstCardPriceWithSplit(root, { fraction: "95" });

  const card = readSearchCards(root)[0];
  assert.equal(card?.displayPriceMinText, "4999.95");
  assert.equal(card?.displayPriceMaxText, "4999.95");
});
```

- [ ] **Step 3: Write fail-closed table tests for every rejected shape**

Add one table-driven test with exact mutations:

```typescript
test("rejects unsupported split-price accessibility shapes", async () => {
  const cases: Array<[string, SplitPriceOptions]> = [
    ["missing currency", { currencyCount: 0 }],
    ["multiple currencies", { currencyCount: 2 }],
    ["missing major position", { majorPosition: null }],
    ["missing fraction size", { fractionSize: null }],
    ["wrong major role", { majorRole: "AXGroup" }],
    ["wrong fraction role", { fractionRole: "AXLink" }],
    ["reversed layout", { fractionPosition: { x: 110, y: 100 } }],
    ["vertically separated", { fractionPosition: { x: 195, y: 130 } }],
    ["not contained", { fractionPosition: { x: 225, y: 100 } }],
    ["not rightmost", { fractionPosition: { x: 140, y: 100 } }],
    ["major too short", { major: "9", fraction: "5" }],
    ["major too long", { major: "123456789", fraction: "5" }],
    ["fraction too long", { fraction: "123" }],
    ["duplicate major node", { duplicateMajor: true }],
    ["third numeric text", { thirdNumeric: "7" }]
  ];

  for (const [name, options] of cases) {
    const root = structuredClone(await fixture("live-search-results.json"));
    replaceFirstCardPriceWithSplit(root, options);
    assert.throws(() => readSearchCards(root), UiContractChangedError, name);
  }
});
```

Keep the existing normal range, distinct-price, shop fallback, nested evidence,
duplicate-scope, and sponsored tests unchanged.

- [ ] **Step 4: Run the focused selector test and verify RED**

Run from `apps/collector` with bundled Node on `PATH`:

```bash
node --test src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the two successful split-price tests fail because the current parser
rejects two distinct numeric texts. Rejection cases may already pass.

- [ ] **Step 5: Implement focused node-aware price resolution**

Add these focused helpers in `taobao-live-selectors.ts` after `priceRange`:

```typescript
interface NumericPriceCandidate {
  text: string;
  nodes: AxNode[];
}

function numericPriceCandidates(nodes: AxNode[]): NumericPriceCandidate[] {
  const grouped = new Map<string, AxNode[]>();
  for (const node of nodes) {
    const text = axNodeText(node);
    if (!text || !priceRange(text)) continue;
    grouped.set(text, [...(grouped.get(text) ?? []), node]);
  }
  return [...grouped].map(([text, groupedNodes]) => ({ text, nodes: groupedNodes }));
}

function containsFrame(outer: AxNode, inner: AxNode): boolean {
  if (!outer.position || !outer.size || !inner.position || !inner.size) return false;
  return inner.position.x >= outer.position.x
    && inner.position.y >= outer.position.y
    && inner.position.x + inner.size.width <= outer.position.x + outer.size.width
    && inner.position.y + inner.size.height <= outer.position.y + outer.size.height;
}

function splitPriceRange(nodes: AxNode[], candidates: NumericPriceCandidate[]): [string, string] | null {
  if (candidates.length !== 2 || candidates.some((candidate) => candidate.nodes.length !== 1)) return null;
  const ordered = [...candidates].sort((left, right) => right.text.length - left.text.length);
  const [majorCandidate, fractionCandidate] = ordered;
  const major = majorCandidate?.nodes[0];
  const fraction = fractionCandidate?.nodes[0];
  if (!majorCandidate || !fractionCandidate || !major || !fraction) return null;
  if (!/^[1-9]\d{1,7}$/.test(majorCandidate.text)
    || !/^\d{1,2}$/.test(fractionCandidate.text)
    || Number(fractionCandidate.text) >= 100
    || majorCandidate.text.length <= fractionCandidate.text.length) return null;
  if (major.role !== "AXStaticText" || fraction.role !== "AXStaticText"
    || major.enabled === false || fraction.enabled === false
    || !major.position || !major.size || !fraction.position || !fraction.size) return null;
  if (fraction.position.x <= major.position.x
    || Math.abs(fraction.position.y - major.position.y) > 20
    || !containsFrame(major, fraction)) return null;
  const fractionCenter = fraction.position.x + fraction.size.width / 2;
  if (fractionCenter < major.position.x + major.size.width * 0.75) return null;
  const currencies = nodes.filter((node) => {
    const text = axNodeText(node);
    return node.enabled !== false && (text === "¥" || text === "￥") && node.position !== null;
  });
  if (currencies.length !== 1) return null;
  const currency = currencies[0];
  if (!currency?.position
    || currency.position.x >= major.position.x
    || Math.abs(currency.position.y - major.position.y) > 20
    || major.position.x - currency.position.x > 120) return null;
  const normalized = Number(
    `${majorCandidate.text}.${fractionCandidate.text.padEnd(2, "0")}`
  ).toFixed(2);
  return [normalized, normalized];
}

function cardPriceRange(nodes: AxNode[]): [string, string] | null {
  const candidates = numericPriceCandidates(nodes);
  if (candidates.length === 1) return priceRange(candidates[0]?.text ?? "");
  return splitPriceRange(nodes, candidates);
}
```

Replace only the price section of `cardEvidence`:

```typescript
function cardEvidence(scope: AxNode, actionNode: AxNode): CardEvidence | null {
  const nodes = cardEvidenceNodes(scope, actionNode);
  const price = cardPriceRange(nodes);
  const shopName = searchShopName(nodes);
  if (!price || !shopName) return null;
  return { price, shopName };
}
```

Do not change any card/shop/scope function or catch parser errors.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run from `apps/collector`:

```bash
node --test src/drivers/macos/taobao-url.spec.ts src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: every focused test passes, including all split-price rejection cases.

- [ ] **Step 7: Run full collector verification**

Run separately from the repository root:

```bash
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: every discovered collector test passes, typecheck exits 0, and diff
check reports no whitespace error.

- [ ] **Step 8: Commit the implementation**

```bash
git add apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
git commit -m "fix: parse split Taobao display prices"
```

---

### Task 2: Verify Current State And Approved Searches

**Files:**
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-split-price-accessibility/current-state-probe.mts`
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-split-price-accessibility/live-search-probe.mts`
- Delete without committing: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/recovery-state-probe.mts`
- Delete without committing: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/shop-url-diagnostic.mts`
- Delete without committing: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/card-evidence-diagnostic.mts`
- Modify ignored evidence only: `.superpowers/sdd/2026-09-01-taobao-split-price-accessibility/task-2-report.md`

**Interfaces:**
- Consumes: Task 1 price parser, existing `AxHelperClient`, `TaobaoMacDriver`, and selector facade.
- Produces: automated evidence, one sanitized current-state summary, two sanitized approved-search summaries, and cleanup evidence with no persistent side effect.

- [ ] **Step 1: Run automated checks**

Use the bundled Node/pnpm runtime on `PATH` and run:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk CLANG_MODULE_CACHE_PATH=/tmp/stau-clang-module-cache SWIFTPM_MODULECACHE_OVERRIDE=/tmp/stau-swiftpm-module-cache swift build --package-path apps/collector-macos
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
git status --short --branch
```

Expected: Swift production helper builds; collector tests/typecheck pass; tracked
tree is clean. Record the known local XCTest limitation without changing the
machine toolchain.

- [ ] **Step 2: Create and run the read-only current-state probe**

The probe snapshots once, checks stop state and whether the query equals the
second approved value internally, calls `readSearchCards`, and prints only:

```typescript
{
  snapshotRead: boolean;
  queryAndFieldAgree: boolean;
  cardsReadable: boolean;
  supportedItemLinkCount: number | null;
  loginOrChallengePresent: boolean | null;
}
```

Expected: all booleans except login/challenge are true,
`loginOrChallengePresent=false`, and `supportedItemLinkCount=42`. Do not run a
search if this read-only check fails.

- [ ] **Step 3: Run the diagnosis gate three times**

Outside the restricted sandbox:

```bash
pnpm collector:diagnose
pnpm collector:diagnose
pnpm collector:diagnose
```

Each must exit 0 with `diagnose_complete` before live search.

- [ ] **Step 4: Create the exact bounded two-search probe**

Use the same `AxHelperClient` and `TaobaoMacDriver` program from the approved
shop-link plan. It runs these values once, in order, with limit 1:

```typescript
"https://detail.tmall.com/item.htm?id=550902914950"
"RME Babyface Pro FS"
```

Print only position counts and termination reasons. The program contains no API
client, claim/report/upload, queue, persistence, database, Enterprise WeChat,
notification, repricing, or collection-run call.

- [ ] **Step 5: Run the probe and poll the same session to completion**

Run once from `apps/collector` outside the restricted sandbox:

```bash
node --import=tsx ../../.superpowers/sdd/2026-09-01-taobao-split-price-accessibility/live-search-probe.mts
```

If command execution yields a session identifier, use that identifier to poll
until completion. Never launch a second probe to compensate for delayed output.
Expected: both position counts are 1 and both termination reasons are
`LIMIT_REACHED`. Stop after a failure.

- [ ] **Step 6: Delete all temporary probes and diagnostics**

Use `apply_patch` to delete both new probes and all three superseded diagnostic
files. Verify all five paths are absent and tracked git status remains clean.

- [ ] **Step 7: Record sanitized evidence only**

Record command pass/fail states, the XCTest limitation, current-state booleans
and count, three diagnosis states, both position counts and termination reasons,
cleanup, and zero lifecycle/persistence/notification side effects. Do not record
product or accessibility content. Do not commit ignored evidence.

---

## Completion Gate

The change is complete only when Task 1 passes task review, current state parses
all 42 supported links, all automated checks pass except the documented local
XCTest limitation, three diagnoses pass, the one bounded live probe produces two
successful sanitized summaries, temporary diagnostics are removed, and final
whole-branch review has no Critical or Important findings.
