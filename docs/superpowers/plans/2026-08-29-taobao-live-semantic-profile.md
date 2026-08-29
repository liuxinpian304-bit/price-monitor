# Taobao Desktop Live Semantic Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS collector read the approved Taobao Desktop `2.4.5` build `15` accessibility tree without synthetic identifiers, then complete a supervised first-three-position RME Babyface smoke run.

**Architecture:** Keep the current identifier-based synthetic selector profile intact and add a separate strict live semantic profile. Public selector functions dispatch by fixture metadata or the absence of reserved synthetic markers. Live selectors interpret raw roles, URLs, descriptions, values, actions, and ancestry, but every mutation continues to use the untouched raw node path and raw fingerprint. The driver adds a Page Down fallback only for the approved live search profile and still requires a changed, stable semantic signature after every page action.

**Tech Stack:** TypeScript 7, Node.js 22+ test runner, pnpm workspace, macOS Accessibility API through the existing Swift helper, NestJS API, PostgreSQL, Redis.

## Global Constraints

- Follow strict TDD. For every behavior task, run the focused test and observe the expected assertion failure before changing production behavior.
- Preserve every existing `synthetic-sanitized` fixture and selector behavior.
- Support only Taobao Desktop `2.4.5` build `15`; the existing version/build gate remains before UI mutation.
- Never synthesize accessibility identifiers onto live nodes. UI actions must use the raw `path`, raw `role`, raw `title`, and real `identifier` only when present.
- SKU option IDs are data-only hashes. Never pass them to `fingerprintFor` or the Swift helper.
- Preserve displayed search order, sponsored positions, and duplicate positions. Do not deduplicate by item ID.
- Use no coordinates, OCR, browser scraping, private API, cookie extraction, CAPTCHA bypass, or automatic repricing.
- Treat login loss, platform challenge, ambiguous nodes, stale paths, changed item identity, conflicting prices, and unstable state as terminal collector issues.
- Commit only fictional `live-sanitized` fixture data. Never commit live item IDs, shop names, prices, screenshots, account data, tokens, webhook URLs, or copied links.
- Do not send the first real Enterprise WeChat message without a fresh operator confirmation after the first-three report is reviewed.

---

### Task 1: Add a Fail-Closed Selector Profile Boundary

**Files:**
- Create: `apps/collector/src/drivers/macos/taobao-selector-profile.ts`
- Create: `apps/collector/src/drivers/macos/taobao-selector-profile.spec.ts`

**Interfaces:**
- Produces: `taobaoSelectorProfile(root: AxNode): "SYNTHETIC" | "LIVE"`.
- Preserves: all current public exports from `taobao-selectors.ts`.

- [ ] **Step 1: Add the profile test with a compiling fail-closed scaffold**

Create `taobao-selector-profile.ts` with the exported type, approved profile constant, and a temporary `taobaoSelectorProfile` implementation that throws `UiContractChangedError("Taobao selector profile is not implemented")`. This scaffold exists only so the RED result is behavioral rather than a module-loader failure.

Add tests covering these exact cases:

```typescript
test("selects the approved synthetic fixture profile", () => {
  assert.equal(taobaoSelectorProfile(root({
    fixtureMetadata: {
      kind: "synthetic-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    },
    children: [node({ identifier: "search-region" })]
  })), "SYNTHETIC");
});

test("selects approved live fixtures and unlabelled raw trees", () => {
  assert.equal(taobaoSelectorProfile(root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    }
  })), "LIVE");
  assert.equal(taobaoSelectorProfile(root({
    children: [node({ role: "AXWebArea", url: "https://s.taobao.com/search?q=Example" })]
  })), "LIVE");
});

test("rejects unknown, unlabelled synthetic, and mixed profiles", () => {
  const unknown = root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-unsupported"
    }
  });
  const unlabelledSynthetic = root({
    children: [node({ identifier: "search-region" })]
  });
  const mixed = root({
    fixtureMetadata: {
      kind: "live-sanitized",
      profile: "taobao-desktop-2.4.5-build-15"
    },
    children: [node({ identifier: "search-region" })]
  });

  assert.throws(() => taobaoSelectorProfile(unknown), UiContractChangedError);
  assert.throws(() => taobaoSelectorProfile(unlabelledSynthetic), UiContractChangedError);
  assert.throws(() => taobaoSelectorProfile(mixed), UiContractChangedError);
});
```

The local `node()` and `root()` test helpers must return complete `AxNode` values with `position` and `size` set to `null`; do not use production code to manufacture expected trees.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-selector-profile.spec.ts
```

Expected: the profile assertions fail with `Taobao selector profile is not implemented`. A syntax or module-resolution failure is not an acceptable RED result.

- [ ] **Step 3: Implement strict profile resolution**

Use the approved profile string exactly:

```typescript
export const APPROVED_TAOBAO_SELECTOR_PROFILE = "taobao-desktop-2.4.5-build-15";
export type TaobaoSelectorProfile = "SYNTHETIC" | "LIVE";
```

Treat these identifiers as reserved synthetic markers:

```typescript
const RESERVED_SYNTHETIC_IDENTIFIERS = new Set([
  "search-region",
  "search-result-list",
  "search-result-query-marker",
  "result-card",
  "item-detail-window",
  "item-header",
  "sku-region",
  "sku-dimension",
  "selected-sku-price",
  "selected-sku-promotions",
  "navigation-back",
  "login-required-dialog",
  "platform-challenge-dialog"
]);
```

Resolution rules:

1. Metadata must contain the exact approved profile.
2. `synthetic-sanitized` requires at least one reserved marker and returns `SYNTHETIC`.
3. `live-sanitized` requires zero reserved markers and returns `LIVE`.
4. An unlabelled raw tree with zero reserved markers returns `LIVE`.
5. Unknown metadata, an unlabelled reserved marker, or any mixed tree throws `UiContractChangedError`.

Read metadata through a runtime-safe shape because JSON can violate the TypeScript union.

- [ ] **Step 4: Run focused and existing selector tests**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-selector-profile.spec.ts apps/collector/src/drivers/macos/taobao-selectors.spec.ts
```

Expected: all tests pass and existing synthetic fixtures remain unchanged.

- [ ] **Step 5: Commit the profile boundary**

```bash
git add apps/collector/src/drivers/macos/taobao-selector-profile.ts apps/collector/src/drivers/macos/taobao-selector-profile.spec.ts
git commit -m "refactor: add Taobao selector profile boundary"
```

---

### Task 2: Parse Live Search Results Without Invented Identifiers

**Files:**
- Create: `apps/collector/src/drivers/macos/taobao-selector-contract.ts`
- Create: `apps/collector/src/drivers/macos/taobao-url.ts`
- Create: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Create: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Create: `apps/collector/test/fixtures/ax/live-search-results.json`
- Create: `apps/collector/test/fixtures/ax/live-search-results-next.json`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`

**Interfaces:**
- Move and re-export unchanged: `SelectedDetailPage` and `SelectedSearchCard`.
- Preserve: `canonicalItemIdentity`, `assertNoStopState`, `findSearchField`, `findSearchResultContainer`, `readSearchResultQuery`, `readSearchCards`, and `hasSearchEndMarker`.
- Add internally: live search-area, card-scope, distinct-text, and supported-item-URL helpers.

- [ ] **Step 1: Add fictional live search fixtures**

Both fixture roots must use:

```json
{
  "fixtureMetadata": {
    "kind": "live-sanitized",
    "profile": "taobao-desktop-2.4.5-build-15"
  }
}
```

Use only this fictional fixture matrix:

| Fixture | Displayed cards | End marker |
| --- | --- | --- |
| `live-search-results.json` | rank 1 `example-x1-a`, rank 2 duplicate `example-x1-a` | no |
| `live-search-results-next.json` | overlap `example-x1-a`, sponsored `example-x1-b`, `example-x1-c` | `没有更多了` |

Use query `Example Interface X1`, shops `Example Audio A`, `Example Audio B`, and `Example Audio C`, and prices `699.00-799.00`, `688.00`, and `720.00`. Direct links use the fictional URLs `https://detail.tmall.com/item.htm?id=example-x1-a` and `https://detail.tmall.com/item.htm?id=example-x1-c`; the sponsored link uses a `click.simba.taobao.com` URL with fictional `id=example-x1-b` and an `广告` marker.

Each fixture must contain:

- one `AXWebArea` with a `s.taobao.com/search` URL;
- one enabled `AXTextField` whose description is `请输入搜索文字` and whose value is the query;
- nested card groups rather than a flat identifier-based shape;
- at least two product links for one card so the parser must collapse duplicate links inside one card while preserving duplicate displayed cards;
- raw live action nodes with `identifier: null`, stable fictional paths, and `actions: ["AXPress"]`.

- [ ] **Step 2: Add live search tests against the existing public API**

Test the following assertions:

```typescript
test("reads the unique live search field and query", async () => {
  const root = await fixture("live-search-results.json");
  assert.equal(findSearchField(root).description, "请输入搜索文字");
  assert.equal(readSearchResultQuery(root), "Example Interface X1");
  assert.equal(findSearchResultContainer(root).role, "AXWebArea");
});

test("preserves displayed duplicates and raw live action nodes", async () => {
  const cards = readSearchCards(await fixture("live-search-results.json"));
  assert.deepEqual(cards.map((card) => [
    card.rank,
    card.platformItemId,
    card.shopName,
    card.displayPriceMinText,
    card.displayPriceMaxText,
    card.sponsored
  ]), [
    [1, "example-x1-a", "Example Audio A", "699.00", "799.00", false],
    [2, "example-x1-a", "Example Audio A", "699.00", "799.00", false]
  ]);
  assert.equal(cards[0]?.actionNode.identifier, null);
  assert.notDeepEqual(cards[0]?.actionNode.path, cards[1]?.actionNode.path);
});

test("keeps sponsored positions and recognizes a verified live end", async () => {
  const root = await fixture("live-search-results-next.json");
  const cards = readSearchCards(root);
  assert.equal(cards[1]?.platformItemId, "example-x1-b");
  assert.equal(cards[1]?.sponsored, true);
  assert.equal(hasSearchEndMarker(root), true);
});
```

Also clone the fixture in memory and prove that a second enabled search field, two distinct prices in one card, two distinct shop labels in one card, and a query mismatch between the field and URL each throw `UiContractChangedError`.

- [ ] **Step 3: Run the focused live search test and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the public selectors reject the live fixture with the existing profile error. Fixture JSON must parse successfully.

- [ ] **Step 4: Extract shared contracts and URL parsing**

Move `SelectedDetailPage` and `SelectedSearchCard` into `taobao-selector-contract.ts`, then re-export them from `taobao-selectors.ts` so `taobao-mac-driver.ts` needs no import change.

Move `canonicalItemIdentity` to `taobao-url.ts` and re-export it from `taobao-selectors.ts`. Add a live search URL parser that accepts only:

- direct `detail.tmall.com` and `item.taobao.com` item URLs;
- Taobao advertising hosts ending in `.simba.taobao.com` with one stable `id`, `item_id`, or `itemId` value.

The parser must reject unsupported hosts, conflicting ID parameters, missing IDs for advertising links, malformed URLs, and IDs outside `[A-Za-z0-9_-]+`. Preserve the actionable raw URL for opening; canonicalization removes fragments and sorts query parameters.

- [ ] **Step 5: Implement live stop-state and search selectors**

`assertNoStopState` must always check both profiles before any mutation:

- retain the synthetic dialog checks;
- detect login only from a login web-area/dialog URL or a scoped login title such as `请登录`, `账号登录`, or `扫码登录`;
- detect a challenge only from a security/punish web-area/dialog URL or scoped text such as `安全验证`, `滑块验证`, or `请完成验证`;
- do not scan arbitrary product text for these phrases.

For live search:

1. Require exactly one `AXWebArea` whose URL host is `s.taobao.com` and path is `/search`.
2. Require exactly one enabled `AXTextField` inside it with description `请输入搜索文字`.
3. Read the query from the field and, when URL parameter `q` exists, require the normalized values to agree.
4. Walk pressable item links in raw traversal order.
5. For each link, find the deepest ancestor inside the search web area that contains one distinct price/range and one distinct shop label.
6. Collapse repeated item links only when they resolve to the same card-scope path; never collapse two different card scopes.
7. Normalize one price as both min/max and one range as two values with exactly two decimal places.
8. Mark a card sponsored when its actionable URL is a Simba advertising URL or its scope contains the exact marker `广告`.
9. Recognize only `没有更多了`, `已到底`, or `已经到底了` as a verified end marker inside the active search area.

Every `SelectedSearchCard.actionNode` and `cardNode` must be the original raw object from the snapshot.

- [ ] **Step 6: Dispatch public search selectors by profile**

Rename the current identifier implementations to private functions prefixed with `synthetic`, such as `syntheticFindSearchField`, `syntheticReadSearchCards`, and `syntheticHasSearchEndMarker`. Public wrappers call `taobaoSelectorProfile(root)` and delegate to either the synthetic implementation or the corresponding live function. Do not mutate or clone the root.

- [ ] **Step 7: Run focused and regression tests**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-selector-profile.spec.ts apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: all profile, synthetic, live, duplicate, sponsored, and ambiguity assertions pass.

- [ ] **Step 8: Commit live search parsing**

```bash
git add apps/collector/src/drivers/macos/taobao-selector-contract.ts apps/collector/src/drivers/macos/taobao-url.ts apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/test/fixtures/ax/live-search-results.json apps/collector/test/fixtures/ax/live-search-results-next.json
git commit -m "feat: parse live Taobao search accessibility trees"
```

---

### Task 3: Parse Live Detail Pages and Every Accessible SKU

**Files:**
- Create: `apps/collector/test/fixtures/ax/live-item-x1-default.json`
- Create: `apps/collector/test/fixtures/ax/live-item-x1-bundle.json`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`

**Interfaces:**
- Preserve: `readDetailPage`, `readSkuDimensions`, `readSelectedLabels`, `findSkuOption`.
- Add internal/export-for-adapter helper: `findLivePurchaseRegion(root: AxNode): AxNode`.
- Produce deterministic data-only SKU option IDs matching `^live-sku-[a-f0-9]{24}$`.

- [ ] **Step 1: Add two fictional live detail fixtures**

Use fictional URL `https://detail.tmall.com/item.htm?id=example-x1-a`, title `Example Interface X1`, and shop `Example Audio A`.

Both fixtures must include one unique `AXWebArea` titled `商品详情`, one purchase region, one raw pressable share control, and these exact dimensions:

| Dimension | Options |
| --- | --- |
| `套餐` | `单机`, `麦克风套装` |
| `颜色` | `银色`, `黑色` |

In `live-item-x1-default.json`, select `单机` and `银色`, and include the minimal scoped label `活动价 699.00`. In `live-item-x1-bundle.json`, select `麦克风套装` and `黑色`, and include `活动价 899.00`. Task 4 extends these minimal price anchors with list price, estimated price, stock, shipping, and promotion evidence. All enabled options expose a raw `AXPress` action and `identifier: null`; one additional disabled option may be included to verify availability mapping.

Represent each dimension as a non-empty label followed by exactly one descendant option group. Do not add synthetic identifiers or copy any live item text.

- [ ] **Step 2: Add failing detail and SKU tests**

Add these assertions:

```typescript
test("reads a unique live detail and all SKU dimensions", async () => {
  const root = await fixture("live-item-x1-default.json");
  const detail = readDetailPage(root);
  assert.deepEqual({
    id: detail.platformItemId,
    title: detail.title,
    shop: detail.shopName
  }, {
    id: "example-x1-a",
    title: "Example Interface X1",
    shop: "Example Audio A"
  });

  const dimensions = readSkuDimensions(root);
  assert.deepEqual(dimensions.map((dimension) => [
    dimension.name,
    dimension.options.map((option) => option.label)
  ]), [
    ["套餐", ["单机", "麦克风套装"]],
    ["颜色", ["银色", "黑色"]]
  ]);
  for (const option of dimensions.flatMap((dimension) => dimension.options)) {
    assert.match(option.id, /^live-sku-[a-f0-9]{24}$/);
  }
});

test("returns raw action nodes while SKU IDs remain data only", async () => {
  const root = await fixture("live-item-x1-default.json");
  const option = findSkuOption(root, "套餐", "麦克风套装");
  assert.equal(option.identifier, null);
  assert.equal(option.actions.includes("AXPress"), true);
  assert.deepEqual(readSelectedLabels(root), { "套餐": "单机", "颜色": "银色" });
});
```

Also prove that two detail web areas, two purchase regions, duplicate dimension labels, duplicate option labels, zero selected options, and two selected options in one dimension each fail closed.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: search assertions pass and the new detail/SKU assertions fail with `UiContractChangedError`.

- [ ] **Step 4: Implement live detail and purchase-region selection**

Require one `AXWebArea` with title `商品详情` and a supported direct item URL. Resolve the canonical identity from that URL.

Within the detail web area, select the deepest unique group that contains:

- one non-empty product-title candidate;
- one shop candidate;
- at least one semantic SKU dimension;
- one selected-SKU price region used by Task 4.

Title and shop candidates must be unique after whitespace normalization. A share node is optional and is returned only when exactly one pressable share/copy-link control exists.

- [ ] **Step 5: Implement deterministic SKU parsing**

Use `node:crypto` and this exact data-ID rule:

```typescript
function skuOptionDataId(dimension: string, label: string): string {
  const normalized = `${normalizeText(dimension)}\u0000${normalizeText(label)}`;
  return `live-sku-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}
```

For each dimension:

1. Identify one non-empty label followed by one option group in semantic child order.
2. Accept only `AXButton` or `AXRadioButton` options with a non-empty label.
3. Require enabled options to expose `AXPress`; map `enabled === false` to `enabled: false`.
4. Determine selection only from raw `selected === true`, boolean `value === true`, or the approved scoped selected-state text in the fixture-derived option node.
5. Require exactly one selected option for `readSelectedLabels`.
6. Return the original raw node from `findSkuOption`; never reconstruct a node from the data ID.

- [ ] **Step 6: Dispatch detail and SKU functions by profile**

Refactor the existing implementations to private synthetic functions and delegate public wrappers through `taobaoSelectorProfile(root)`. Keep every existing synthetic output byte-for-byte equivalent.

- [ ] **Step 7: Run focused and collector selector tests**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: all search, detail, SKU, raw-action, deterministic-ID, and ambiguity tests pass.

- [ ] **Step 8: Commit live detail and SKU parsing**

```bash
git add apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/test/fixtures/ax/live-item-x1-default.json apps/collector/test/fixtures/ax/live-item-x1-bundle.json
git commit -m "feat: parse live Taobao detail SKUs"
```

---

### Task 4: Scope Live Price, Stock, and Promotion Evidence

**Files:**
- Create: `apps/collector/src/drivers/macos/taobao-live-price-evidence.ts`
- Create: `apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-price-evidence.ts`
- Modify: `apps/collector/test/fixtures/ax/live-item-x1-default.json`
- Modify: `apps/collector/test/fixtures/ax/live-item-x1-bundle.json`

**Interfaces:**
- Preserve: `readSelectedSkuEvidence(root: AxNode): SelectedSkuEvidence`.
- Reuse unchanged: `yuanTextToFen` and `parsePromotionLabel`.
- Live reader consumes only `findLivePurchaseRegion(root)` output.

- [ ] **Step 1: Add fictional price evidence to both detail fixtures**

Use these exact fictional values:

| Fixture | List | Activity | Estimated | Stock | Promotions |
| --- | --- | --- | --- | --- | --- |
| default | `799.00` | `699.00` | `679.00` | `有货` | `满500减20`, `88VIP专享` |
| bundle | absent | `899.00` | absent | `无货` | `50元券` |

Place all evidence inside the purchase region. Add unrelated recommendation prices outside that region to prove they are ignored. Include `包邮` so the mandatory fee is explicitly `0.00`.

- [ ] **Step 2: Add failing live price tests**

Test exact output for both fixtures:

```typescript
test("reads selected live SKU evidence only from the purchase region", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-item-x1-default.json"));
  assert.equal(evidence.listPriceText, "799.00");
  assert.equal(evidence.activityPriceText, "699.00");
  assert.equal(evidence.officialEstimatedPayablePriceText, "679.00");
  assert.equal(evidence.mandatoryFeeText, "0.00");
  assert.equal(evidence.stockState, "IN_STOCK");
  assert.deepEqual(evidence.promotionTexts, ["满500减20", "88VIP专享"]);
});

test("uses activity price as list price when no explicit list price exists", async () => {
  const evidence = readSelectedSkuEvidence(await fixture("live-item-x1-bundle.json"));
  assert.equal(evidence.listPriceText, "899.00");
  assert.equal(evidence.activityPriceText, "899.00");
  assert.equal(evidence.stockState, "OUT_OF_STOCK");
});
```

Clone fixtures in memory and prove that two distinct activity prices, two distinct explicit list prices, conflicting stock text, malformed price precision, and price evidence outside the purchase region each fail or remain ignored as appropriate.

- [ ] **Step 3: Run the focused price test and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts
```

Expected: the existing identifier-based reader reports that the selected-SKU price region is missing.

- [ ] **Step 4: Implement the strict live price reader**

Inside the unique live purchase region:

1. Collect normalized text once in raw traversal order.
2. Require one distinct activity amount labeled `活动价`, `活动到手价`, or `店铺优惠后`.
3. Accept at most one distinct crossed-out or explicitly labeled `原价`/`划线价`; when absent, copy activity price to list price.
4. Accept at most one `预估到手价`/`预计到手价`; otherwise return `null`.
5. Map explicit `有货`, `现货`, or `库存充足` to `IN_STOCK`; map `无货`, `售罄`, or `缺货` to `OUT_OF_STOCK`; map no explicit state to `UNKNOWN`; reject conflicting states.
6. De-duplicate promotion labels in traversal order and pass them to the existing `parsePromotionLabel` without subtracting them.
7. Map explicit `包邮` to mandatory fee `0.00`; parse one explicit `运费` amount; preserve the existing `0.00` fallback only when no positive mandatory-fee evidence is exposed.
8. Use `yuanTextToFen` for every amount and reject conflicting distinct values.

- [ ] **Step 5: Dispatch the public evidence reader**

Keep the current reader as a private synthetic implementation. `readSelectedSkuEvidence` delegates through `taobaoSelectorProfile(root)` and returns the same `SelectedSkuEvidence` shape for both profiles.

- [ ] **Step 6: Run focused and regression tests**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-price-evidence.spec.ts apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: all synthetic and live price, promotion, stock, and ambiguity tests pass.

- [ ] **Step 7: Commit live selected-SKU evidence**

```bash
git add apps/collector/src/drivers/macos/taobao-live-price-evidence.ts apps/collector/src/drivers/macos/taobao-live-price-evidence.spec.ts apps/collector/src/drivers/macos/taobao-price-evidence.ts apps/collector/test/fixtures/ax/live-item-x1-default.json apps/collector/test/fixtures/ax/live-item-x1-bundle.json
git commit -m "feat: read live Taobao SKU price evidence"
```

---

### Task 5: Add Live Page-Down Progress and Exact Return Navigation

**Files:**
- Create: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selector-contract.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Modify: `apps/collector/test/fixtures/ax/live-item-x1-default.json`

**Interfaces:**
- Add: `SearchAdvance` and `readSearchAdvance(root: AxNode): SearchAdvance`.
- Change: `findBackAction(root: AxNode, exactQuery?: string): AxNode`.
- Preserve: `TaobaoDesktopDriver` public interface.

- [ ] **Step 1: Define the search-advance contract**

Add this exact union to `taobao-selector-contract.ts`:

```typescript
export type SearchAdvance =
  | { kind: "AX_ACTION"; action: "AXScrollDown"; node: AxNode }
  | { kind: "KEY"; keyCode: 121 };
```

The synthetic profile returns `AX_ACTION` only when the profiled result container exposes `AXScrollDown`. The live profile prefers an `AXScrollDown` node inside the active search area and otherwise returns Page Down key code `121`. Neither profile may return coordinates.

- [ ] **Step 2: Add a fixture-backed live driver test harness**

Create a dedicated fake client in `taobao-mac-driver-live.spec.ts` that:

- returns approved Taobao diagnostics;
- queues snapshots and records every command;
- returns each stable search/detail/SKU snapshot three consecutive times;
- returns fictional copied text only when a test explicitly exercises copied-link recovery;
- never rewrites node identifiers.

Add tests proving:

1. `search("Example Interface X1", 3)` sends `setValue`, Return key `36`, then Page Down key `121` and returns ranks `example-x1-a`, duplicate `example-x1-a`, and sponsored `example-x1-b`.
2. Page Down followed by an unchanged stable signature throws `UiContractChangedError` for no semantic progress.
3. Opening a live position sends `perform/AXPress` with the exact raw path and a fingerprint that has no invented `identifier` property.
4. `selectSku({ "套餐": "麦克风套装", "颜色": "黑色" })` presses the raw option nodes, re-snapshots after each action, and returns the bundle fixture's selected labels and evidence.
5. `returnToSearch()` presses the unique raw tab whose normalized title/value exactly equals `Example Interface X1`, then waits for the original query and exact search signature.
6. Multiple exact-query tabs, no exact-query tab plus multiple back buttons, stale paths, and changed item IDs each fail closed.

Add one raw pressable search tab with the exact fictional query to `live-item-x1-default.json`; keep its `identifier` null.

- [ ] **Step 3: Run the live driver tests and verify RED**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: tests fail because the driver still requires `AXScrollDown` on the result container and the old back selector requires `navigation-back`.

- [ ] **Step 4: Implement profile-specific search advance**

Export `readSearchAdvance` from `taobao-selectors.ts` and replace both direct scroll blocks in `TaobaoMacDriver.search` and `TaobaoMacDriver.locateCard` with one private helper:

```typescript
private async advanceSearch(root: AxNode): Promise<void> {
  const advance = readSearchAdvance(root);
  if (advance.kind === "KEY") {
    await this.client.command("keyPress", { keyCode: advance.keyCode });
    return;
  }
  await this.client.command("perform", {
    nodePath: advance.node.path,
    action: advance.action,
    fingerprint: fingerprintFor(advance.node)
  });
}
```

Keep the existing before-action signature, three stable observations, 15-second deadline, overlap merge, 50-page cap, and explicit no-progress error. A Page Down event is successful only when the semantic signature changes and stabilizes.

- [ ] **Step 5: Implement exact live return navigation**

Change the driver call to:

```typescript
const back = findBackAction(detail, this.currentSearchQuery);
```

For the live profile:

1. Prefer exactly one enabled, pressable tab/button whose normalized title or string value exactly equals the active query.
2. If no exact-query tab exists, accept exactly one enabled, pressable back control titled `返回`.
3. Reject multiple matches and never use position/size.
4. Return the untouched raw node.

Keep the existing synthetic `navigation-back` behavior when `exactQuery` is omitted or the profile is synthetic. After pressing, retain `waitForStableSearchReturn` and its exact original signature requirement.

- [ ] **Step 6: Run focused and all driver tests**

Run:

```bash
node --test apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
```

Expected: all live and synthetic driver tests pass. Recorded live `perform` commands contain only raw paths and raw fingerprints.

- [ ] **Step 7: Commit live driver integration**

```bash
git add apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-selector-contract.ts apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/test/fixtures/ax/live-item-x1-default.json
git commit -m "feat: drive live Taobao search and SKU flows"
```

---

### Task 6: Verify the Repository and Public-Data Boundary

**Files:**
- Modify only files required by failures directly caused by Tasks 1-5.
- Do not modify report semantics, database schema, WeCom send controls, or unrelated UI.

- [ ] **Step 1: Run all collector tests**

```bash
pnpm test:collector
```

Expected: every collector test passes, including all existing synthetic fixtures and new live-sanitized fixtures.

- [ ] **Step 2: Run Swift helper tests**

```bash
swift test --package-path apps/collector-macos
```

Expected: all helper protocol, accessibility-node, and screenshot tests pass. No Swift source change should be needed.

- [ ] **Step 3: Run full repository verification**

```bash
pnpm verify
pnpm audit:public
git diff --check
```

Expected: local environment, config, contracts, API, collector, web, E2E, typecheck, build, public audit, and whitespace checks all pass. The existing non-failing Vite large-chunk warning is allowed; no new warning is allowed.

- [ ] **Step 4: Inspect every tracked live-sanitized fixture and artifact**

Run:

```bash
git status --short
git diff --stat codex/public-release...HEAD
git diff codex/public-release...HEAD -- apps/collector/test/fixtures/ax
```

Confirm manually that every new fixture contains only the fictional `Example Interface X1` dataset, that no `.png` or raw live snapshot is tracked, and that no credential or webhook appears in the diff.

- [ ] **Step 5: Commit verification-only corrections if needed**

If verification required source corrections, stage only those corrections and commit:

```bash
git commit -m "test: harden live Taobao profile verification"
```

Do not create an empty commit when no correction was needed.

---

### Task 7: Run the Supervised First-Three Live Acceptance

**Files:**
- No committed source files.
- Live screenshots and raw evidence remain under the ignored collector work directory.
- Pilot catalog values remain in the local database.

- [ ] **Step 1: Confirm the clean implementation state**

Run:

```bash
git status --short
```

Expected: clean worktree before any live business data is collected.

- [ ] **Step 2: Keep fixture preview and real API separated**

Leave the UI acceptance preview on its current fixture port. Start or verify the real API on loopback port `4101`, then run:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:diagnose
```

Expected: API, database, Redis, queue, collector pairing, Taobao app, permissions, approved version/build, and logged-in state all report healthy. Do not print tokens or `.env` contents.

- [ ] **Step 3: Register one local pilot model through the admin UI**

Use these non-secret catalog values:

- monitor code: `RME-BABYFACE-PRO-FS-PILOT`;
- enabled: `true` only for the supervised smoke window;
- brand: `RME`;
- standard model: `Babyface Pro FS`;
- category: `声卡`;
- search query: `RME Babyface`;
- version: `FS`;
- required terms: `RME`, `Babyface`, `Pro`, `FS`;
- excluded terms: `二手`, `样机`, `租赁`, `维修`, `配件`;
- comparison type: `BARE`;
- color comparable: `false`;
- owner: `运营`.

Enter the operator-confirmed own listing URL and exact bare-SKU label only in the local admin UI. Do not place either value in source, shell history, this plan, screenshots intended for Git, or test fixtures.

- [ ] **Step 4: Enqueue exactly three displayed positions**

From the local admin UI, enqueue the pilot with `searchLimit = 3`. Confirm the returned run is queued for the intended pilot and is not a scheduled first-50 run.

- [ ] **Step 5: Run one supervised collection**

With the operator watching Taobao Desktop, run:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:once
```

Stop immediately on login loss, a platform challenge, unexpected page structure, changed item identity, or repeated no-progress state. Do not bypass any prompt.

- [ ] **Step 6: Review the terminal report before any notification**

Verify manually:

- exactly the first three displayed ranks are represented in order;
- sponsored and duplicate positions remain visible as separate ranks;
- each rank has the correct item ID, link, shop, and title;
- every accessible SKU combination is represented or has an explicit issue;
- each selected SKU has stable activity price, stock, promotions, and local evidence;
- missing own combinations and lower-price comparisons are separated correctly;
- no partial run is labeled complete.

Do not send Enterprise WeChat and do not change any shop price during this review.

- [ ] **Step 7: Disable the pilot until the report is approved**

After the smoke run, disable the local pilot model so the scheduler cannot start an unattended run. Present the first-three report to the operator. Only after explicit approval may the pilot be re-enabled, the limit raised to `50`, and a separate first-50 run started. Request a fresh confirmation before the first real Enterprise WeChat send.

## Completion Criteria

- All focused RED/GREEN cycles were observed and recorded in the implementation notes.
- Existing synthetic and new live-sanitized selector/driver tests pass.
- Full repository verification, Swift tests, public audit, and whitespace checks pass.
- The live first-three run reaches a terminal report or stops with an explicit issue; it never guesses or bypasses a platform control.
- Git contains no live business data, screenshots, credentials, account data, or webhook URLs.
- No Enterprise WeChat message or automatic repricing occurs during acceptance.
