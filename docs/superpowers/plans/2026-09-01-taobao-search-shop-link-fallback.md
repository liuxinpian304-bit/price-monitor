# Taobao Search Shop-Link Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fail-closed parsing of current Taobao Desktop search cards by accepting one uniquely identified shop link when legacy shop accessibility descriptions are absent.

**Architecture:** Add a focused URL predicate in `taobao-url.ts` that recognizes only HTTP(S) Taobao/Tmall hosts with an exact `shop`, `store`, or `seller` hostname segment. Keep explicit shop accessibility descriptions authoritative in `taobao-live-selectors.ts`; consult text-bearing, enabled, pressable links passing the URL predicate only when no explicit shop name exists, and accept only one distinct fallback name.

**Tech Stack:** TypeScript, Node.js test runner, macOS Accessibility helper, Swift Package Manager.

## Global Constraints

- Keep explicit `店铺` and `店铺名称` accessibility descriptions as the primary shop-name source.
- Use the fallback only when no explicit shop name exists.
- Require exactly one distinct fallback shop name from enabled `AXLink` nodes that support `AXPress`, expose non-empty text, and pass the strict shop URL predicate.
- Reject zero or multiple distinct fallback names; never choose by order, position, or text length.
- Continue requiring exactly one distinct display-price text in the selected card scope.
- Do not infer shop names from arbitrary static text.
- Do not open product detail pages to discover shop names.
- Do not skip ambiguous cards or silently return partial results.
- Do not change rank ordering, duplicate-scope handling, sponsored detection, stability timing, or mutation behavior.
- Do not start a collection run or any API job lifecycle.
- Do not write checkpoints, database records, or other persistent state.
- Do not send Enterprise WeChat messages, notifications, or repricing actions.
- Run only the two previously approved non-persistent `driver.search()` probes after three successful diagnoses.
- Live output is limited to counts, termination reasons, booleans, and supported-link counts; never print product titles, shop names, URLs, prices, queries, raw accessibility trees, credentials, or environment values.

---

### Task 1: Classify Strict Live Shop URLs

**Files:**
- Create: `apps/collector/src/drivers/macos/taobao-url.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-url.ts:3-55`

**Interfaces:**
- Consumes: `string | null` accessibility URLs.
- Produces: `isSupportedLiveShopUrl(rawUrl: string | null): boolean`.

- [ ] **Step 1: Write the focused failing URL-classification test**

Create `taobao-url.spec.ts` with the exact accepted and rejected boundaries:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedLiveShopUrl } from "./taobao-url.ts";

test("recognizes only strict Taobao and Tmall shop host segments", () => {
  for (const url of [
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a",
    "https://shop.m.taobao.com/shop/shop_index.htm?shop_id=fictional-b",
    "https://store.tmall.com/",
    "http://seller.taobao.com/"
  ]) {
    assert.equal(isSupportedLiveShopUrl(url), true, url);
  }

  for (const url of [
    null,
    "not a url",
    "ftp://shop.taobao.com/shop/view_shop.htm",
    "https://shop.example.com/",
    "https://shopping.taobao.com/",
    "https://taobao.com.example.net/shop",
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    "https://item.taobao.com/item.htm?id=example-x1-a"
  ]) {
    assert.equal(isSupportedLiveShopUrl(url), false, String(url));
  }
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run from `apps/collector` with the bundled Node runtime on `PATH`:

```bash
node --test src/drivers/macos/taobao-url.spec.ts
```

Expected: FAIL because `isSupportedLiveShopUrl` is not exported.

- [ ] **Step 3: Implement the minimal strict predicate**

Add the focused host constants and predicate to `taobao-url.ts`:

```typescript
const SHOP_HOST_SEGMENTS = new Set(["shop", "store", "seller"]);
const LIVE_PLATFORM_HOST_SUFFIXES = ["taobao.com", "tmall.com"];

function isLivePlatformHost(host: string): boolean {
  return LIVE_PLATFORM_HOST_SUFFIXES.some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`));
}

export function isSupportedLiveShopUrl(rawUrl: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return isLivePlatformHost(host)
      && host.split(".").some((segment) => SHOP_HOST_SEGMENTS.has(segment));
  } catch {
    return false;
  }
}
```

Do not accept free-form path/query substrings, partial hostname words such as
`shopping`, non-platform hosts, or unsupported schemes. The observed current
live shape has shop semantics in an exact hostname segment on a Taobao-family
host, so no broader URL rule is needed.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test src/drivers/macos/taobao-url.spec.ts
```

Expected: the URL classification test passes.

- [ ] **Step 5: Run typecheck and whitespace validation**

Run separately from the repository root:

```bash
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the classifier**

```bash
git add apps/collector/src/drivers/macos/taobao-url.ts apps/collector/src/drivers/macos/taobao-url.spec.ts
git commit -m "feat: classify Taobao shop links"
```

---

### Task 2: Resolve Search Shops With A Strict Fallback

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts:10-12,97-114,143`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts:45-60,336-430`

**Interfaces:**
- Consumes: `isSupportedLiveShopUrl(rawUrl: string | null): boolean`, `AxNode`, and existing `cardEvidence(scope)` traversal.
- Produces: unchanged `liveReadSearchCards(root): SelectedSearchCard[]` with a strictly resolved `shopName` for current live cards.

- [ ] **Step 1: Add test helpers for explicit evidence and shop links**

Add these helpers beside `firstCardScope` and `axNode` in
`taobao-live-selectors.spec.ts`:

```typescript
const SEARCH_SHOP_DESCRIPTIONS = new Set(["店铺", "店铺名称"]);

function removeExplicitShopEvidence(scope: AxNode): void {
  for (const node of walkAxNodes(scope)) {
    if (node.description && SEARCH_SHOP_DESCRIPTIONS.has(node.description)) {
      node.description = null;
    }
  }
}

function appendShopLink(scope: AxNode, childIndex: number, title: string, url: string): void {
  scope.children.push(axNode([...scope.path, childIndex], {
    role: "AXLink",
    title,
    url,
    enabled: true,
    actions: ["AXPress"]
  }));
}
```

- [ ] **Step 2: Write the focused failing selector tests**

Replace the existing "ignores a pressable shop link" test with explicit
precedence coverage, then add the fallback boundary cases:

```typescript
test("keeps an explicit shop name authoritative over a shop-link fallback", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  appendShopLink(
    scope,
    4,
    "Fallback Audio A",
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a"
  );

  assert.equal(readSearchCards(root)[0]?.shopName, "Example Audio A");
});

test("uses one strict shop link when explicit shop evidence is absent", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  removeExplicitShopEvidence(scope);
  appendShopLink(
    scope,
    4,
    "Fallback Audio A",
    "https://shop.taobao.com/shop/view_shop.htm?user_number_id=fictional-a"
  );

  assert.equal(readSearchCards(root)[0]?.shopName, "Fallback Audio A");
});

test("accepts the explicit shop-name accessibility description", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const shop = walkAxNodes(firstCardScope(root)).find((node) => node.description === "店铺");
  assert.ok(shop);
  shop.description = "店铺名称";

  assert.equal(readSearchCards(root)[0]?.shopName, "Example Audio A");
});

test("rejects a live card with neither explicit shop evidence nor a shop link", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  removeExplicitShopEvidence(firstCardScope(root));

  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects multiple distinct shop-link fallback names", async () => {
  const root = structuredClone(await fixture("live-search-results.json"));
  const scope = firstCardScope(root);
  removeExplicitShopEvidence(scope);
  appendShopLink(scope, 4, "Fallback Audio A", "https://shop.taobao.com/a");
  appendShopLink(scope, 5, "Fallback Audio B", "https://store.tmall.com/b");

  assert.throws(() => readSearchCards(root), UiContractChangedError);
});

test("rejects invalid shop-link fallback URLs", async () => {
  for (const url of [
    "ftp://shop.taobao.com/a",
    "https://shop.example.com/a",
    "https://shopping.taobao.com/a",
    "https://detail.tmall.com/item.htm?id=example-x1-a"
  ]) {
    const root = structuredClone(await fixture("live-search-results.json"));
    const scope = firstCardScope(root);
    removeExplicitShopEvidence(scope);
    appendShopLink(scope, 4, "Not A Shop", url);

    assert.throws(() => readSearchCards(root), UiContractChangedError, url);
  }
});
```

The existing distinct-price and distinct-explicit-shop rejection tests remain
unchanged and continue to cover fail-closed ambiguity.

- [ ] **Step 3: Run the selector test and verify RED**

Run from `apps/collector`:

```bash
node --test src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the unique-fallback and `店铺名称` cases fail because the current
parser accepts only `description === "店铺"`; the rejection and precedence
cases may already pass.

- [ ] **Step 4: Implement explicit-first shop resolution**

Import `isSupportedLiveShopUrl`, reuse the existing shared
`SHOP_DESCRIPTIONS` set for explicit evidence, and add these focused helpers:

```typescript
function explicitShopNames(nodes: AxNode[]): string[] {
  return distinctText(nodes.map((node) =>
    node.description !== null
      && SHOP_DESCRIPTIONS.has(node.description)
      && typeof node.value === "string"
      && node.value.trim()
      ? node.value.trim()
      : null));
}

function fallbackShopNames(nodes: AxNode[]): string[] {
  return distinctText(nodes.map((node) => {
    if (node.role !== "AXLink"
      || node.enabled === false
      || !node.actions.includes("AXPress")
      || !isSupportedLiveShopUrl(node.url)) return null;
    return axNodeText(node);
  }));
}

function searchShopName(scope: AxNode): string | null {
  const nodes = walkAxNodes(scope);
  const explicit = explicitShopNames(nodes);
  if (explicit.length > 1) return null;
  if (explicit.length === 1) return explicit[0] ?? null;
  const fallback = fallbackShopNames(nodes);
  return fallback.length === 1 ? fallback[0] ?? null : null;
}
```

Update `cardEvidence` without changing its price logic:

```typescript
function cardEvidence(scope: AxNode): CardEvidence | null {
  const priceTexts = distinctText(walkAxNodes(scope).map((node) => {
    const text = axNodeText(node);
    return text && priceRange(text) ? text : null;
  }));
  const shopName = searchShopName(scope);
  if (priceTexts.length !== 1 || !shopName) return null;
  const price = priceRange(priceTexts[0] ?? "");
  if (!price) return null;
  return { price, shopName };
}
```

Do not catch parser errors, skip unsupported cards, or add positional/textual
heuristics.

- [ ] **Step 5: Run both focused test files and verify GREEN**

Run from `apps/collector`:

```bash
node --test src/drivers/macos/taobao-url.spec.ts src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: both files pass, including all legacy selector cases.

- [ ] **Step 6: Run the collector suite and typecheck**

Run separately from the repository root:

```bash
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: every discovered collector test passes, typecheck passes, and no
whitespace errors are reported.

- [ ] **Step 7: Commit the selector fallback**

```bash
git add apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
git commit -m "fix: resolve Taobao search shops from links"
```

---

### Task 3: Verify With Sanitized Non-Persistent Probes

**Files:**
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/live-search-probe.mts`
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/final-state-probe.mts`
- Delete without committing: `.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/stability-diagnostic.mts`
- Delete without committing: `.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/card-shape-diagnostic.mts`
- Modify, ignored evidence only: `.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/task-3-report.md`

**Interfaces:**
- Consumes: the Task 1 URL predicate, Task 2 selector fallback, existing `AxHelperClient`, and existing `TaobaoMacDriver`.
- Produces: automated verification evidence, two sanitized search summaries, and one sanitized final-state summary without product data or persistent side effects.

- [ ] **Step 1: Run all automated verification**

Use the bundled Node/pnpm runtime on `PATH` and run these separately from the
repository root:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk CLANG_MODULE_CACHE_PATH=/tmp/stau-clang-module-cache SWIFTPM_MODULECACHE_OVERRIDE=/tmp/stau-swiftpm-module-cache swift build --package-path apps/collector-macos
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
git status --short --branch
```

Expected: the Swift production helper builds; every collector test and
typecheck passes; the tracked tree is clean. Record the known local XCTest gap:
the installed Command Line Tools contain neither XCTest nor Testing, and the
default SDK/compiler pair is mismatched.

- [ ] **Step 2: Run the diagnosis gate three separate times**

Run outside the restricted sandbox so loopback/helper access is available:

```bash
pnpm collector:diagnose
pnpm collector:diagnose
pnpm collector:diagnose
```

Each command must exit 0 with `diagnose_complete` before either search probe is
run. Stop without searching if any diagnosis fails.

- [ ] **Step 3: Create the exact two-search probe**

Create `live-search-probe.mts` with this program:

```typescript
import { AxHelperClient } from "../../../apps/collector/src/drivers/macos/ax-helper-client.ts";
import { TaobaoMacDriver } from "../../../apps/collector/src/drivers/macos/taobao-mac-driver.ts";

const client = new AxHelperClient();
const driver = new TaobaoMacDriver({ client });

try {
  const own = await driver.search(
    "https://detail.tmall.com/item.htm?id=550902914950",
    1
  );
  const model = await driver.search("RME Babyface Pro FS", 1);
  console.log(JSON.stringify({
    ownPositions: own.positions.length,
    ownTerminationReason: own.terminationReason,
    modelPositions: model.positions.length,
    modelTerminationReason: model.terminationReason
  }));
} finally {
  client.close();
}
```

The program must contain no API client, run claim, report upload, queue,
persistence, database, notification, Enterprise WeChat, or repricing call.

- [ ] **Step 4: Run the two-search probe once**

Run from `apps/collector`, outside the restricted sandbox:

```bash
node --import=tsx ../../.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/live-search-probe.mts
```

Expected: both searches return one position with `LIMIT_REACHED`. Stop after a
failure; do not retry a failed live mutation outside the driver's own bounded
observation loop.

- [ ] **Step 5: Capture the final state with a read-only probe**

Create `final-state-probe.mts` with this program:

```typescript
import {
  LoginRequiredError,
  PlatformChallengeError
} from "../../../apps/collector/src/core/desktop-driver.ts";
import { AxHelperClient } from "../../../apps/collector/src/drivers/macos/ax-helper-client.ts";
import {
  assertNoStopState,
  findSearchField,
  readSearchCards,
  readSearchResultQuery
} from "../../../apps/collector/src/drivers/macos/taobao-selectors.ts";

const expected = "RME Babyface Pro FS";
const client = new AxHelperClient();

try {
  const root = await client.snapshot();
  let loginOrChallengePresent = false;
  try {
    assertNoStopState(root);
  } catch (error) {
    if (error instanceof LoginRequiredError || error instanceof PlatformChallengeError) {
      loginOrChallengePresent = true;
    } else {
      throw error;
    }
  }
  const field = findSearchField(root);
  const resultQuery = readSearchResultQuery(root);
  console.log(JSON.stringify({
    snapshotRead: true,
    queryAndFieldAgree: field.value === expected && resultQuery === expected,
    supportedItemLinkCount: readSearchCards(root).length,
    loginOrChallengePresent
  }));
} catch {
  console.log(JSON.stringify({
    snapshotRead: false,
    queryAndFieldAgree: false,
    supportedItemLinkCount: null,
    loginOrChallengePresent: null
  }));
  process.exitCode = 1;
} finally {
  client.close();
}
```

Run it once from `apps/collector`, outside the restricted sandbox:

```bash
node --import=tsx ../../.superpowers/sdd/2026-09-01-taobao-search-shop-link-fallback/final-state-probe.mts
```

Expected: `snapshotRead=true`, `queryAndFieldAgree=true`,
`supportedItemLinkCount >= 1`, and `loginOrChallengePresent=false`.

- [ ] **Step 6: Remove all temporary diagnostics and probes**

Delete the two Task 3 probes and the two superseded diagnostic programs with
`apply_patch`. Verify that all four paths are absent and that `git status`
contains no unexpected tracked change.

- [ ] **Step 7: Record only sanitized verification evidence**

In the ignored task report, record:

- automated command pass/fail states;
- the documented Swift XCTest toolchain limitation;
- three diagnosis pass/fail states;
- position counts and termination reasons from the two approved probes;
- final-state booleans and supported-item count; and
- zero API runs, claims, releases, heartbeats, reports, uploads, queue writes,
  persistence writes, database writes, Enterprise WeChat sends, notifications,
  repricing actions, and collection runs.

Do not record titles, shops, URLs, prices, query text, accessibility content,
credentials, environment values, or raw helper output. Do not commit ignored
SDD evidence.

---

## Completion Gate

The change is complete only when Tasks 1 and 2 pass task review, all automated
verification is green except the documented local XCTest toolchain limitation,
three diagnoses pass, both approved live probes return one stable position, the
final snapshot agrees with the model query, all temporary diagnostics are
removed, and final whole-branch review reports no Critical or Important
findings.
