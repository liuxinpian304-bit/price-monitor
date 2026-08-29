# Taobao Desktop Live Semantic Profile Design

**Date:** 2026-08-29

## Status

Approved direction: add a strict live semantic profile for Taobao Desktop `2.4.5` build `15`, then run a supervised three-position smoke collection for the RME Babyface search.

## Context

The macOS collector is automated and fully covered against synthetic accessibility fixtures, but its first live inspection exposed a deliberate acceptance gap. The real Taobao accessibility tree does not contain the semantic identifiers embedded in those fixtures. Version, build, permissions, login state, API reachability, and collector pairing all pass, but the existing selectors fail closed when they attempt to read a real product detail page.

The live inspection also confirmed two environmental facts that do not require source changes:

- the UI acceptance fixture had occupied the default API port, so the real API must use a separate loopback port during live acceptance;
- the real Taobao tree exposes stable roles, URLs, descriptions, text, actions, and child order, but no application-defined identifiers for the search and detail regions.

No live item ID, shop name, price, screenshot, account data, token, or webhook may be committed. Live evidence remains only under ignored local work directories.

## Goals

1. Parse real search results, item details, SKU dimensions, selected-SKU prices, stock, and promotions on the approved Taobao build.
2. Preserve the existing synthetic fixture profile and all of its tests.
3. Keep every UI action tied to a current raw accessibility path and raw fingerprint.
4. Preserve duplicate search positions and collect at most the requested first 50 displayed positions.
5. Fail closed on ambiguity, login loss, platform challenges, stale paths, changed item identity, unstable prices, or unsupported page structure.
6. Complete a supervised RME Babyface smoke run for the first three displayed positions before attempting 50.

## Non-Goals

- Supporting other Taobao versions or builds.
- Supporting Windows desktop collection.
- Using coordinates, OCR, browser scraping, private APIs, account cookies, or CAPTCHA bypasses.
- Automatically changing any store price.
- Sending the first real Enterprise WeChat message without a fresh operator confirmation.
- Treating a partial run as a complete first-50 report.

## Considered Approaches

### 1. Dedicated live selector profile (chosen)

Keep the current synthetic selectors and add a separate live profile selected only after the driver validates version `2.4.5` and build `15`. Live selectors use raw roles, URLs, descriptions, values, actions, and semantic ancestry. They return the original actionable node, so helper fingerprint checks continue to validate the real node.

This is the safest option because semantic interpretation and UI mutation remain separate, existing fixture behavior stays stable, and live ambiguity can be rejected locally.

### 2. Rewrite the raw tree with synthetic identifiers

This would let existing selectors run unchanged, but an identifier added only by the Node layer would leak into `fingerprintFor`. The Swift helper would then compare that invented identifier with a real node whose identifier is absent and reject the action. Adding a second hidden fingerprint representation would create unnecessary coupling.

### 3. Hard-code observed child paths

This is small but brittle. Dynamic banners, advertisements, and personalized content can move descendants while preserving the same semantic page. It is unsuitable for a price-monitoring workflow.

## Architecture

### Profile dispatch

Public selector functions remain the driver-facing API and dispatch internally:

- `synthetic-sanitized` fixtures use the current identifier-based implementation;
- `live-sanitized` fixtures and real trees use the new live implementation;
- unknown fixture profiles and mixed or ambiguous trees are rejected.

The driver must validate the installed application version and build before any live selector is allowed to mutate the UI. A live selector never relaxes that gate.

### Search selection

The live search profile must require exactly one active Taobao search web area and exactly one enabled search field with the approved search description. The current query is read from the field and cross-checked against the search URL when that URL includes a query.

Displayed product positions are derived from pressable links in raw accessibility traversal order. A candidate must have:

- a supported Taobao or Tmall item destination, or a Taobao advertising destination with a stable item ID;
- one non-empty product description;
- one unambiguous displayed price or price range;
- one unambiguous shop label in the same semantic card.

Advertising destinations remain positions and are marked sponsored; duplicate item IDs at different displayed ranks remain separate positions. Shop links, navigation links, recommendations outside the active result list, and accessory controls are not cards.

The profile prefers semantic `AXScrollDown`. If the live tree exposes no scroll action and fewer than the requested positions are loaded, the driver may use the already allowlisted Page Down key while the approved search web area is active. Each page action must produce a changed, stable search signature. No progress or ambiguous progress is an error.

### Detail and item identity

The live detail root is the unique `AXWebArea` titled as a product detail page with a supported Taobao or Tmall item URL. The canonical item ID is read from the URL and must match the position that was opened when the search card already supplied an ID.

The product title and shop name are selected from the unique purchase region associated with that detail root. If a stable item ID is absent, copied-link capture remains an optional recovery path only when the page exposes one unambiguous pressable share control. Failure to recover an ID produces the existing missing-item issue instead of guessing.

### SKU dimensions and UI actions

The live SKU parser finds a dimension label followed by one semantic option group inside the purchase region. Each enabled option must expose one pressable raw node and one non-empty label. Option IDs are deterministic hashes of the dimension and normalized label; they are data identifiers only and are never sent back to the Swift helper as accessibility fingerprints.

Selecting an option always uses the raw node path plus its raw role, title, and real identifier when present. After every action, the driver obtains a new snapshot, re-identifies the same item, verifies the selected labels, and waits for stable price evidence.

### Price, stock, and promotion evidence

The live price reader is scoped to the active purchase region. It requires one activity-payable price label and rejects multiple conflicting prices. A crossed-out or explicitly labeled pre-discount amount may supply list price; otherwise list price equals activity price without inventing a discount.

Stock is mapped only from explicit in-stock or out-of-stock text. Unknown wording remains `UNKNOWN`. Public promotion labels are passed through the existing strict promotion parser. Unsupported, account-specific, threshold-incomplete, or ambiguous promotion text lowers confidence or requires review; it is never silently subtracted.

### Return to search

When the live app keeps the search page as a separate accessible tab, return navigation selects the unique tab whose title matches the exact active query. Otherwise, one unambiguous raw back action may be used. The driver then waits for the original query and result signature to return. It never uses screen coordinates.

## Error Handling

- Login and platform challenge states stop immediately and require manual recovery.
- Multiple matching search fields, detail roots, price regions, shops, dimensions, or selected options are profile errors.
- A stale path or changed fingerprint is rejected by the Swift helper.
- A changed item ID after opening or selecting a SKU is rejected.
- A partial search remains partial unless the requested limit is reached or the page exposes a verified end state.
- The collector does not repeatedly retry a structurally changed page.

## Test Strategy

1. Add minimal `live-sanitized` search and detail fixtures whose structure is derived from the approved live build but whose products, shops, item IDs, prices, and URLs are fictional.
2. Write failing live-profile tests before implementation for search query, ordered cards, sponsored and duplicate positions, item identity, shop/title, SKU dimensions, raw action paths, selection state, price, stock, promotions, and return navigation.
3. Add ambiguity tests that prove the live profile fails closed.
4. Keep every existing synthetic fixture and driver test passing.
5. Run collector tests, Swift helper tests, type checking, the full repository verification, and the public repository audit.
6. Confirm that committed fixtures contain no live business or account data.

## Live Acceptance Flow

1. Keep the real API on a dedicated loopback port while the UI fixture preview remains available.
2. Register one enabled RME Babyface Pro FS pilot model using the operator-confirmed own listing and one bare-SKU reference. The search query remains `RME Babyface`.
3. Run diagnostics again, enqueue a limit-three job, and run `collector:once` with the operator present.
4. Manually verify all three ranks, item IDs, links, shops, every accessible SKU, selected-SKU prices, stock, promotions, and local evidence.
5. Review the generated report. Do not send Enterprise WeChat and do not change any store price during this smoke run.
6. Only after the three-position result is accepted may a first-50 run be attempted.

## Acceptance Criteria

- The real RME Babyface limit-three job reaches a terminal report without bypassing login or platform controls.
- All three displayed ranks and every accessible SKU are represented or have an explicit issue.
- The own listing is collected from the canonical operator-confirmed URL.
- Every action uses raw accessibility paths and raw fingerprints; no coordinates are introduced.
- Existing synthetic tests, new live-profile tests, full verification, Swift tests, and public audit pass.
- Git contains no live prices, shops, item IDs, screenshots, account data, tokens, or webhooks.
