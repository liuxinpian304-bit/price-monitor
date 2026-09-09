# Taobao Desktop DOM-Backed SKU Profile Design

**Date:** 2026-09-03

## Status

Approved under the operator's standing instruction to apply the recommended safe option without another confirmation. The change repairs the supervised Taobao Desktop `2.4.5` build `15` collector before the first three-position acceptance run.

## Context

The first live own-listing run reaches the correct product detail web area but fails during detail stabilization. A raw snapshot proves that the installed supported build exposes the page as generic `AXGroup` nodes and does not expose the semantic descriptions represented by the existing `live-sanitized` fixtures.

An attribute-level diagnostic found two usable native signals that the serializer currently omits:

- SKU option groups expose `AXDOMClassList`, including a stable semantic class prefix for options and a separate selected-state prefix.
- `AXUIElementPerformAction(..., AXPress)` succeeds for an option even when Chromium omits `AXPress` from `AXUIElementCopyActionNames`.

No live item IDs, shop names, prices, SKU labels, screenshots, account data, tokens, cookies, or webhooks may be committed.

## Goals

1. Parse the real supported detail page while preserving the existing synthetic and semantic-live profiles.
2. Enumerate SKU options from DOM-backed accessibility classes without coordinates, OCR, browser scraping, cookies, or private network APIs.
3. Select each SKU through a dedicated, fail-closed helper command and verify that the requested option becomes the unique selected option.
4. Scope title, shop, stock, promotions, and price evidence to one unambiguous purchase region.
5. Complete a supervised first-three-position smoke run before any first-50 run.

## Considered Approaches

### 1. DOM-backed accessibility profile (chosen)

Serialize a small allowlist of native Chromium accessibility attributes, identify SKU option and selected-state class prefixes, and add a dedicated SKU press command. This preserves raw paths, exact build gating, and post-action verification without introducing screen coordinates.

### 2. Exact child paths

This is smaller but unsafe because server-driven banners and product content can shift child indices. It is rejected.

### 3. Screen coordinates or OCR

This could click generic groups but cannot provide a trustworthy identity or selected-state contract. It is rejected.

## Architecture

### Serialized attributes

`AXNode` gains `domClassList: string[] | null`. The Swift serializer reads only `AXDOMClassList`, accepts only strings, applies the existing sensitive-term sanitizer to every entry, sorts the result, and rejects non-array values. The attribute is descriptive evidence and is included in raw snapshots; it is not an invented identifier.

### Detail profile dispatch

The existing semantic live parser remains unchanged for approved fixtures. A detail web area can use the DOM-backed branch only when all of these conditions hold:

- there is exactly one supported `AXWebArea` titled `商品详情`;
- exactly one purchase region contains the product action controls, one stock state, one title candidate, and one SKU dimension cluster;
- exactly one supported shop link is associated with that product region;
- SKU option nodes contain exactly one option-class prefix and each exposes exactly one non-empty label;
- exactly one enabled option per dimension has the selected-class prefix.

Recommendations, reviews, parameter tables, and unrelated prices outside this region are ignored. Multiple candidates or missing anchors are contract errors.

### Dedicated SKU action

The helper protocol adds `pressSkuOption`. It resolves the fresh raw path and fingerprint, then requires:

- supported application version and build;
- a frontmost Taobao window;
- role `AXGroup`;
- one DOM class with the approved SKU option prefix;
- no disabled-state class;
- a non-empty descendant label matching the requested normalized label.

Only then may the helper call native `AXPress`, even if Chromium omitted that action from its reported action list. The generic `perform` command remains strict and unchanged.

After the action, the driver takes a new snapshot and requires the requested label to be the unique selected option. A stale path, mismatched class list, changed label, unchanged selection, or changed item identity fails closed.

### Price evidence

The selected-SKU price reader identifies one DOM-backed price region inside the purchase region. It accepts explicit current/list-price labels and split currency/major/fraction nodes already supported by the price parser. Distinct current prices, malformed precision, missing stock, or evidence outside the purchase region are rejected or marked for review under the existing rules.

### Own listing navigation

The desktop application does not accept a Tmall HTTP URL through the macOS application-open mechanism, and searching either a literal URL or a numeric item ID produces unrelated fuzzy matches. `openOwnListing` therefore receives the monitored search query and own shop name in addition to the canonical listing URL.

It searches `searchQuery + ownShopName`, reads at most 50 displayed positions, and requires exactly one position whose canonical item ID equals the configured listing ID and whose normalized shop name equals the configured own shop. Only that raw result node may be opened. The detail panel must then transition to and stabilize on the same item ID and shop. No match, multiple matches, a stale retained detail panel, or an identity mismatch produces an explicit own-baseline or UI-contract issue; the collector never chooses the first fuzzy result.

## Testing

1. Add fictional DOM-backed detail fixtures derived from the observed structure.
2. Observe focused tests fail before production changes.
3. Cover title/shop isolation, SKU enumeration, selected-state parsing, dedicated press validation, price evidence, stale detail rejection, and ambiguity failures.
4. Cover own-listing lookup by the configured item ID and shop, including no-match, duplicate-match, and stale-detail failures.
5. Keep all current semantic-live and synthetic tests passing.
6. Run Swift tests with the compatible local SDK override, collector tests, type checks, full verification, and the public-data audit.
7. Run one supervised three-position collection with Enterprise WeChat disabled and no repricing capability.

## Acceptance Criteria

- The supported live detail page stabilizes from a fresh transition, not a retained panel.
- Every accessible SKU is selected and verified, or the report contains an explicit per-item issue.
- No coordinate, OCR, cookie, browser scraping, CAPTCHA bypass, automatic repricing, or Enterprise WeChat send is introduced.
- Ambiguity remains fail-closed.
- All focused and repository verification commands pass.
- Committed fixtures and logs contain only fictional product data.
