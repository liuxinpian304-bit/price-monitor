# Task 9 Report: Taobao Desktop 2.4.5 macOS Driver

## Status

Implemented Task 9 from base commit `df470efcb979e03d3cf02e5a4277e705a4bb7778`.

The collector now has a long-lived macOS Accessibility helper client, fixture-profiled semantic selectors, exact Taobao Desktop `2.4.5` build `15` gating, stable item identity resolution, exact selected-SKU stability waits, public promotion evidence parsing, semantic search/detail/back navigation, and collision-resistant flat PNG evidence capture.

## Implementation

- Added `AxHelperClient` with a module-relative development helper path and `TAOBAO_AX_HELPER_PATH` override.
- Commands use UUID correlation, one JSON request per line, a pending-promise map, and a 15,000 ms timeout.
- Helper stdout is treated as protocol-only. Malformed, blank, unknown-ID, exit, spawn-error, input-error, and timeout paths reject all pending work.
- A failed command receives exactly one shared clean helper restart, including when several pending commands fail together. A second transport failure becomes a sanitized `UiContractChangedError`.
- Helper protocol errors retain only a sanitized uppercase code and redacted bounded message. Stderr forwarding is a constant redacted diagnostic and never forwards raw stderr.
- Added exact AX value types and semantic traversal helpers. Coordinates and geometry are retained only because the Task 8 protocol exposes them; no selector reads them as identity.
- Added profiled selectors for the search field, result container/cards/end marker, detail title/shop/item URL/share action, SKU dimensions/options/selected state, price region, promotion region, stock, back action, login, and platform challenge.
- Search cards preserve display order and duplicate ranks while canonicalizing stable IDs and URLs when an `id` query parameter is present.
- Detail identity accepts a full AX URL first. Host-only details use `captureCopiedText` on the accessible copy-link action and retain only the canonicalized result.
- Missing stable identity raises typed `MISSING_ITEM_ID`. The runner truncates unresolved URL-fallback positions, does not create a competitor item, resets item traversal to search for retry, and cannot report full completion.
- Exact version/build mismatches raise `APP_VERSION_UNSUPPORTED` before snapshots or UI actions. Observed values allow only bounded alphanumeric, dot, underscore, and hyphen output. Version failures are not checkpointed, so retry cannot bypass diagnosis.
- Selected-SKU stability polls every 250 ms for at most 15 seconds and requires three consecutive equal selected labels, item ID, activity-price text, and promotion text.
- Dynamic disabled options return unavailable. Selected-label mismatch returns the observed view without a screenshot so the existing runner records `SKU_SELECTION_MISMATCH` and stores no price conclusion.
- Deadline instability raises typed `PRICE_UNSTABLE`; the runner records it with item and SKU context and completes only that failed SKU outcome.
- Price extraction accepts one decimal-yuan value only from the profiled selected-SKU list/activity/estimated/fee labels. Activity price requires an explicit activity-price label.
- Promotion parsing recognizes strict `满X减Y`, `X元券`, and `立减X元` forms. Extra or unscoped numbers are rejected.
- 88VIP, member, account-specific, and personal-red-packet benefits are retained as non-public evidence. Stack groups are assigned only for explicitly profiled, separately identified promotion rows; otherwise they remain null.
- Search uses semantic set-value, Return, result-container scroll, accessible result-link press, accessible back press, and query/result-list verification. No pointer, coordinate, DOM, OCR, or global text action was added.
- Price screenshots use `taobao-<sanitized-item-id>-<uuid>.png`, with no slash or child directory, directly under `COLLECTOR_WORK_DIR`.

## Fixtures

Accessibility permission was checked read-only through normal `diagnose`, without the prompt value. The installed permission state returned exactly one sanitized `ACCESSIBILITY_PERMISSION_REQUIRED` response and zero stderr bytes, so a live snapshot was not permitted.

The five checked-in fixtures are therefore minimal, explicitly marked `synthetic-sanitized`, scoped to profile `taobao-desktop-2.4.5-build-15`, and marked for live validation by Task 14. They contain deterministic example IDs, hosts, shops, hierarchy, roles, labels, selected state, and only the price/promotion evidence required by tests. No challenge was triggered.

Task 14 must replace or validate these fixtures against a sanitized live Accessibility snapshot before broadening selector support.

## TDD Evidence

The first required focused run failed RED with `ERR_MODULE_NOT_FOUND` for the selector, price-evidence, and helper-client production modules.

The driver test then failed RED with `ERR_MODULE_NOT_FOUND` for `taobao-mac-driver.ts`.

Additional RED checks covered:

- missing `DriverIssueError` before typed `APP_VERSION_UNSUPPORTED` and `MISSING_ITEM_ID` report handling;
- an unresolved URL fallback surviving as a report item ID;
- missing `DriverSkuIssueError` before selection-time `PRICE_UNSTABLE` handling.

Each focused test passed after its minimal implementation. The final collector run passed 61 tests with zero failures.

## Verification

- `pnpm test:collector`: PASS, 61 tests, 0 failures.
- `pnpm typecheck`: PASS for API, web, and collector projects.
- Focused selector/price/client/driver tests: PASS.
- `git diff --check`: PASS.
- Task 9 changed-file public audit using the repository audit functions: PASS for all 17 staged implementation/fixture files before this report was added.
- Semantic implementation scan found no pointer, coordinate, DOM, OCR, or raw global-text action path.
- `swiftc -frontend -parse`: PASS for all production and XCTest sources.
- Direct helper build at deployment target `arm64-apple-macosx12.0`: PASS with isolated caches and the SDK interface compatibility flag.
- Swift 5 production typecheck with warnings as errors: PASS.
- Strict Swift 6 production typecheck with complete concurrency and warnings as errors: PASS.
- Direct helper protocol check: exactly one valid `ACCESSIBILITY_PERMISSION_REQUIRED` response line and zero stderr bytes.

## SwiftPM Environment Issue

`swift test --package-path apps/collector-macos` was attempted and failed while compiling the unchanged package manifest before test discovery.

The selected compiler is Apple Swift `6.3.3`, while the active macOS SDK Swift interfaces were built with Apple Swift `6.3.2`. The default Clang module cache is also not writable in the managed sandbox. The exact SDK diagnostic is:

```text
this SDK is not supported by the compiler (the SDK is built with 'Apple Swift version 6.3.2 ...', while this compiler is 'Apple Swift version 6.3.3 ...')
```

No Swift test or production behavior was weakened for this host issue. Direct parse, build, Swift 5 typecheck, strict Swift 6 typecheck, and protocol checks passed as described above.

## Public Audit Concern

The required full `pnpm audit:public` command was run after staging Task 9. Task 9 files produced no audit finding. The command remains nonzero because the base commit already contains three absolute local paths in `docs/superpowers/plans/2026-08-21-local-demo-runtime-fixes.md` at lines 242, 243, and 291. Those historical-plan paths are unrelated to Task 9 and were not rewritten.

## Self-Review

- Verified exact `2.4.5` plus build `15` checks occur before every first mutation and cannot be bypassed by an unsupported-version checkpoint.
- Verified no selector uses `position`, `size`, coordinates, OCR, DOM, or pointer actions.
- Verified duplicate cards remain separate positions and no stable item ID is fabricated.
- Verified all helper transport exits, spawn errors, malformed lines, typed helper errors, timeouts, concurrent pending failures, and one-restart exhaustion paths are bounded and sanitized.
- Verified mismatch and unstable SKU outcomes write no validated price screenshot/conclusion.
- Verified every generated screenshot destination is one collision-resistant `.png` filename with no path separator.
- An independent nested Codex review was attempted in read-only mode, but the nested process could not initialize its state database under the managed sandbox. The final review was completed in-process.

## Remaining Concerns

- Live Accessibility snapshots and UI actions remain unverified because Accessibility permission is absent. Task 14 must validate or replace the synthetic sanitized profile fixtures.
- The full public audit remains blocked by three pre-existing historical-plan paths from the base commit, although the Task 9 changed-file audit passes.
- SwiftPM XCTest remains blocked by the local compiler/SDK mismatch; direct compiler and protocol verification passed.
