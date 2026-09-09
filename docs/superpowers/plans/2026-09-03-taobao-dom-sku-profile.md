# Taobao Desktop DOM-Backed SKU Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the supported Taobao Desktop collector read and select generic Chromium SKU nodes safely, locate the configured own listing by exact item and shop identity, and complete the supervised three-position smoke run.

**Architecture:** Extend the Swift accessibility allowlist with sanitized DOM class lists and a dedicated SKU-only press command. Keep synthetic and semantic-live behavior intact, add a DOM-backed detail branch with strict structural anchors, and replace literal-URL own-listing search with an exact identity lookup inside a shop-qualified search.

**Tech Stack:** Swift 6 / macOS Accessibility API, TypeScript 7, Node.js 22+, pnpm workspace, Node test runner, PostgreSQL, Redis.

## Global Constraints

- Support only Taobao Desktop `2.4.5` build `15` for live mutation.
- Never use screen coordinates, OCR, browser scraping, cookies, private network APIs, or CAPTCHA bypass.
- Never auto-change a store price.
- Keep Enterprise WeChat disabled during the first-three smoke run and require fresh operator confirmation before its first real send.
- Keep the generic `perform` helper command strict; only `pressSkuOption` may tolerate Chromium omitting `AXPress` from the reported action list.
- Every SKU action must use a fresh raw path, raw fingerprint, expected normalized label, and post-action selected-state verification.
- Commit only fictional fixture data. Do not commit live item IDs, shop names, prices, labels, screenshots, account data, tokens, cookies, or webhook URLs.

---

### Task 1: Serialize Sanitized DOM Class Evidence

**Files:**
- Modify: `apps/collector-macos/Sources/TaobaoAX/AXNode.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift`
- Modify: `apps/collector/src/drivers/macos/ax-node.ts`
- Modify: `apps/collector/src/drivers/macos/ax-node.spec.ts`

**Interfaces:**
- Produces Swift `AXNode.domClassList: [String]?`.
- Produces TypeScript `AxNode.domClassList?: string[] | null` and `hasDomClassPrefix(node, prefix)`.
- Preserves decoding of all existing fixtures that omit the property.

- [ ] **Step 1: Add failing Swift serializer tests**

Add assertions that `AXDOMClassList` is requested, string entries are normalized into a sorted array, sensitive entries are removed, non-array values become `nil`, and JSON contains `domClassList` without adding arbitrary AX attributes.

```swift
let root = TestAXElement(attributes: [
    AXAttribute.role: "AXGroup",
    AXAttribute.domClassList: ["valueItem--fixture", "isSelected--fixture"],
])
let node = try AXTreeSerializer().serialize(root: root, scope: .focusedWindow).node
XCTAssertEqual(node.domClassList, ["isSelected--fixture", "valueItem--fixture"])
```

- [ ] **Step 2: Run the Swift test and verify RED**

Run from `apps/collector-macos`:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
CLANG_MODULE_CACHE_PATH=/private/tmp/stau-clang-cache \
SWIFT_MODULECACHE_PATH=/private/tmp/stau-swift-cache \
swift test --disable-sandbox --filter AXNodeTests
```

Expected: compile or assertion failure because `domClassList` and `AXAttribute.domClassList` do not exist.

- [ ] **Step 3: Implement the Swift allowlist**

Add `AXDOMClassList` to `AXAttribute.allowed`. Decode only `[String]`, sanitize each string with `AXAttributeSanitizer`, remove empty entries, deduplicate, sort, and expose `nil` when no safe classes remain. Add the optional property to `AXNode` with a default of `nil` so old construction sites keep compiling.

- [ ] **Step 4: Add and run TypeScript shape tests**

Test the helper below with missing, matching, non-matching, and malformed fixture values:

```typescript
export function hasDomClassPrefix(node: AxNode, prefix: string): boolean {
  return Array.isArray(node.domClassList)
    && node.domClassList.some((value) => value.startsWith(prefix));
}
```

Run:

```bash
node --test apps/collector/src/drivers/macos/ax-node.spec.ts
```

Expected after implementation: PASS.

- [ ] **Step 5: Run focused Swift and TypeScript tests**

Run both commands from Steps 2 and 4. Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/collector-macos/Sources/TaobaoAX/AXNode.swift apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift apps/collector/src/drivers/macos/ax-node.ts apps/collector/src/drivers/macos/ax-node.spec.ts
git commit -m "feat: expose sanitized Taobao DOM class evidence"
```

---

### Task 2: Add a Dedicated Fail-Closed SKU Press Command

**Files:**
- Modify: `apps/collector-macos/Sources/TaobaoAX/AXNode.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/Protocol.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/AccessibilityApplicationTests.swift`
- Modify: `apps/collector/src/drivers/macos/ax-node.ts`
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.ts`
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`

**Interfaces:**
- Produces helper command `pressSkuOption` with `nodePath`, `value` as expected label, and `fingerprint`.
- Extends `AXNodeFingerprint` / `AxNodeFingerprint` with optional exact `domClassList`.
- Produces `AxHelperClient.pressSkuOption(node, expectedLabel): Promise<void>`.

- [ ] **Step 1: Add failing Swift protocol and action tests**

Cover decoding the command, rejecting missing path/value/fingerprint, rejecting empty labels, mismatched role/class/label, disabled classes, stale fingerprints, non-frontmost state, and propagation of native action errors. Add a success case where the option reports only `AXShowMenu` and `AXScrollToVisible`, but native `AXPress` succeeds after all SKU guards pass.

Use fictional classes only:

```swift
AXNodeFingerprint(
    role: "AXGroup",
    title: nil,
    identifier: nil,
    domClassList: ["valueItem--fixture"]
)
```

- [ ] **Step 2: Run focused Swift tests and verify RED**

Run:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
CLANG_MODULE_CACHE_PATH=/private/tmp/stau-clang-cache \
SWIFT_MODULECACHE_PATH=/private/tmp/stau-swift-cache \
swift test --disable-sandbox --filter ProtocolTests
```

Then run the same command with `--filter AccessibilityApplicationTests`. Expected: failures because the command and guards do not exist.

- [ ] **Step 3: Implement the Swift command and guards**

Add `.pressSkuOption` to `CommandName`. Require exactly one normalized expected label. Resolve the current element with role/title/identifier/DOM-class fingerprint checks. Require role `AXGroup`, one class starting `valueItem--`, no class matching `/disabled|sold.?out|unavailable/i`, and exactly one descendant text equal to the expected label. Confirm the Taobao process is frontmost and call native `AXPress` directly. Do not weaken `perform` or `captureCopiedText`.

- [ ] **Step 4: Add failing Node client tests**

Assert that `pressSkuOption` sends exactly:

```typescript
{
  command: "pressSkuOption",
  nodePath: option.path,
  value: expectedLabel,
  fingerprint: fingerprintFor(option)
}
```

Also prove that `fingerprintFor` copies a sorted DOM class list and that malformed helper responses still fail closed.

- [ ] **Step 5: Implement and verify the Node client**

Add `pressSkuOption` to `AxHelperCommandName`, add the client method, and run:

```bash
node --test apps/collector/src/drivers/macos/ax-helper-client.spec.ts apps/collector/src/drivers/macos/ax-node.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Run all Swift helper tests and commit**

Run:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
CLANG_MODULE_CACHE_PATH=/private/tmp/stau-clang-cache \
SWIFT_MODULECACHE_PATH=/private/tmp/stau-swift-cache \
swift test --disable-sandbox
```

Expected: PASS.

Commit:

```bash
git add apps/collector-macos apps/collector/src/drivers/macos/ax-node.ts apps/collector/src/drivers/macos/ax-helper-client.ts apps/collector/src/drivers/macos/ax-helper-client.spec.ts
git commit -m "feat: add guarded Taobao SKU press action"
```

---

### Task 3: Parse the Generic DOM-Backed Detail Profile

**Files:**
- Create: `apps/collector/test/fixtures/ax/live-dom-item-x1-default.json`
- Create: `apps/collector/test/fixtures/ax/live-dom-item-x1-bundle.json`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-price-evidence.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts`

**Interfaces:**
- Preserves `liveReadDetailPage`, `liveReadSkuDimensions`, `liveReadSelectedLabels`, `liveFindSkuOption`, and `readLiveSelectedSkuEvidence`.
- Adds an internal DOM-backed purchase-region parser selected only when the semantic purchase region is absent and the complete DOM contract is unique.

- [ ] **Step 1: Add fictional DOM-backed fixtures**

Derive only the minimum hierarchy needed from the observed page. Use item ID `example-x1-a`, shop `Example Audio A`, title `Example Interface X1`, dimension `套餐`, options `单机` and `麦克风套装`, current price `699.00`, list price `799.00`, stock `有货`, and `包邮`. Use fictional classes such as `valueItem--fixture`, `isSelected--fixture`, and `price--fixture`.

The bundle fixture changes the unique selected class and current price while preserving the item and shop identity. Do not copy any live value.

- [ ] **Step 2: Add selector tests and verify RED**

Assert exact detail identity, title, shop, option order, deterministic option IDs, raw option paths, enabled state, and unique selected label. Clone fixtures in memory and prove duplicate detail areas, duplicate shop links, duplicate selected options, missing action buttons, missing labels, and multiple purchase regions throw `UiContractChangedError`.

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the DOM fixtures fail with the approved profile error.

- [ ] **Step 3: Implement DOM-backed detail selection**

Keep the semantic branch first. For the DOM branch, require one supported detail area, one supported shop link, one region containing an add-to-cart button plus a purchase button, one title candidate before the price region, one stock marker, and one or more dimension clusters. A dimension cluster has one label subtree and one option-list subtree whose direct option children each have `valueItem--` and one non-empty label. Selected state comes only from a unique `isSelected--` class.

Return the original raw option node from `liveFindSkuOption`; do not clone or invent identifiers.

- [ ] **Step 4: Add price tests and verify RED**

Assert that current and list price, shipping, stock, and concrete promotions are read only from the DOM-backed purchase region. Add failures for two current prices, two list prices, conflicting stock states, malformed precision, and recommendation prices outside the purchase region.

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts
```

Expected: the DOM fixture is rejected before implementation.

- [ ] **Step 5: Implement explicit DOM-backed price grouping**

Recognize explicit labels `店铺优惠后`, `活动价`, `活动到手价`, `优惠前`, `原价`, `划线价`, `运费`, and the existing stock markers. Support split currency/major/fraction nodes only inside the uniquely labeled price group. Reuse existing yuan conversion and promotion parsing; never infer a discount from an unrelated numeric node.

- [ ] **Step 6: Run selector and price regressions and commit**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts
```

Expected: PASS.

Commit:

```bash
git add apps/collector/test/fixtures/ax/live-dom-item-x1-default.json apps/collector/test/fixtures/ax/live-dom-item-x1-bundle.json apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-live-price-evidence.ts apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts
git commit -m "fix: parse Taobao DOM-backed item details"
```

---

### Task 4: Use the Dedicated Action and Verify Every Selection

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`

**Interfaces:**
- Consumes `AxHelperClient.pressSkuOption(node, expectedLabel)`.
- Preserves `selectSku(selection): Promise<DriverSkuSelectionResult>`.

- [ ] **Step 1: Add failing driver tests**

Use a DOM-backed default snapshot, a post-press bundle snapshot, and stable repeated snapshots. Assert that the driver invokes only `pressSkuOption` for DOM-backed options, waits for two stable observations, verifies the requested selection, verifies item identity, and then captures evidence. Add failures for unchanged selection, a different selected label, changed item ID, and stale helper errors.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
```

Expected: DOM-backed selection fails because the generic `perform` path rejects the option.

- [ ] **Step 3: Implement action dispatch**

Use `pressSkuOption` when the raw option has a `valueItem--` DOM class. Keep the current `AXPress` action path for semantic-live and synthetic buttons. After every press, read a fresh snapshot and require `readSelectedLabels` to match the requested partial selection before moving to the next dimension. Preserve final stable price and screenshot checks.

- [ ] **Step 4: Run focused tests and commit**

Run the command from Step 2. Expected: PASS.

Commit:

```bash
git add apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
git commit -m "fix: select generic Taobao SKU nodes safely"
```

---

### Task 5: Locate the Own Listing by Exact Search Identity

**Files:**
- Modify: `apps/collector/src/core/desktop-driver.ts`
- Modify: `apps/collector/src/core/collection-runner.ts`
- Modify: `apps/collector/src/core/collection-runner.spec.ts`
- Modify: `apps/collector/src/drivers/fixture/fixture-driver.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`

**Interfaces:**
- Replaces `openOwnListing(url: string)` with:

```typescript
openOwnListing(input: {
  url: string;
  searchQuery: string;
  ownShopName: string;
}): Promise<DriverItemPage>;
```

- The runner passes `listing.url`, `job.searchQuery`, and `job.ownShopName`.

- [ ] **Step 1: Add failing driver lookup tests**

Assert the search text is normalized from `${searchQuery} ${ownShopName}`, the lookup reads at most 50 positions, and exactly one card must match both canonical item ID and normalized shop name. Add failures for zero matches, duplicate matches, ID-only matches from another shop, shop-only matches with another ID, and a retained detail panel whose identity did not transition.

- [ ] **Step 2: Add failing runner contract tests**

Assert the runner passes all three fields and still rejects a page whose item ID or shop differs from the configured claim. Update fixture-driver call sites without changing report semantics.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts apps/collector/src/core/collection-runner.spec.ts
```

Expected: compile/assertion failures from the old string-only method.

- [ ] **Step 4: Implement exact own-listing lookup**

Search with the shop-qualified query and limit 50. Filter by the canonical configured ID and whitespace-normalized exact shop name. Require one match, open only that raw position, and require the stable detail to match both fields. Do not reuse a pre-existing detail panel as success; the open transition must produce the matched item identity.

- [ ] **Step 5: Run focused tests and commit**

Run the command from Step 3. Expected: PASS.

Commit:

```bash
git add apps/collector/src/core/desktop-driver.ts apps/collector/src/core/collection-runner.ts apps/collector/src/core/collection-runner.spec.ts apps/collector/src/drivers/fixture/fixture-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
git commit -m "fix: bind own listing lookup to item and shop"
```

---

### Task 6: Verify the Repository and Run the Supervised Pilot

**Files:**
- Modify only if commands reveal a directly related defect; return to RED/GREEN for any such change.

**Interfaces:**
- Consumes the completed helper and collector.
- Produces one local three-position report for operator review; no external notification.

- [ ] **Step 1: Run all Swift tests**

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
CLANG_MODULE_CACHE_PATH=/private/tmp/stau-clang-cache \
SWIFT_MODULECACHE_PATH=/private/tmp/stau-swift-cache \
swift test --disable-sandbox
```

Expected: PASS.

- [ ] **Step 2: Run collector and contract tests**

```bash
pnpm --filter @stau-price-monitor/collector test
pnpm --filter @stau-price-monitor/contracts test
```

Expected: PASS.

- [ ] **Step 3: Run type checks and full verification**

```bash
pnpm typecheck
pnpm verify
pnpm public:audit
```

Expected: all commands exit 0 and the public audit reports no live/private artifacts.

- [ ] **Step 4: Rebuild and diagnose the local helper**

Build with the SDK/cache environment from Step 1, copy or point `.env.collector` at the new debug helper, activate Taobao Desktop, and run:

```bash
pnpm collector:diagnose
```

Expected: supported version/build, accessibility, screen recording, front window, login, API pairing, and helper checks pass.

- [ ] **Step 5: Enqueue a fresh three-position run**

Create a new run for the existing pilot model with `searchLimit: 3`. Do not requeue a failed run. Confirm from settings that Enterprise WeChat remains unconfigured or disabled.

- [ ] **Step 6: Run one collector job and inspect the terminal report**

Run:

```bash
pnpm collector:once
```

Expected: the job reaches a terminal report with an exact own baseline, three displayed search ranks, every accessible SKU or an explicit per-item issue, and local evidence paths.

- [ ] **Step 7: Review the report in the local web app**

Open the new run page at `http://127.0.0.1:4173/runs/<run-id>`. Check item IDs, links, shops, ranks, SKU labels, selected-SKU prices, stock, promotions, and issue rows. Do not send Enterprise WeChat and do not change any price.

- [ ] **Step 8: Commit any final directly related corrections and record verification evidence**

If no correction was needed, leave the tree clean. If a correction was required, repeat its focused RED/GREEN cycle, then commit only the related files with a narrow message.
