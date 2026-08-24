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

## Fix Round 1

### RED Evidence

- Host-only identity regression: two ranks sharing one host-only URL initially collapsed to the first detail ID and incorrectly completed. The new pause/resume probe failed before rank-scoped unresolved identities were introduced.
- Late missing-ID checkpoint regression: after an earlier competitor completed, a later `MISSING_ITEM_ID` left competitor data in `SEARCH` phase and failed Task 6 semantic validation on resume.
- UTF-8 transport regression: splitting the first byte of `淘` from the remaining bytes decoded the payload as `���宝` before stream-level UTF-8 decoding was enabled.
- SKU attribution regression: three stable selected-SKU snapshots for `different-item` were accepted after opening `example-7506`; the probe failed because no typed rejection occurred.
- Search transition regression: a pre-submit list whose field already matched the requested query returned the stale `旧结果` card before the result-query marker changed.
- Detail transition regression: the first temporary search snapshot threw the profile contract error instead of polling through to the stable detail page.
- Scroll-boundary regression: an identical card at a distinct AX path was treated as complete overlap and no new rank was produced.
- Back verification regression: a stable unrelated result list was accepted because only query text and generic list stability were checked. The selector probe also failed before result-query and occurrence metadata were exported.

### GREEN Evidence

- Null-ID search positions now use deterministic `unresolved:<rank>:sha256:<canonical-url-hash>` checkpoint identities. Each rank resolves independently, aliases only its own position, survives pause/resume, and cannot enter a complete checkpoint while unresolved.
- A detail page without a stable ID records `MISSING_ITEM_ID`, removes unresolved completion claims, and returns the checkpoint to search for a later retry.
- Missing-ID rollback now clears all search-derived positions, competitor items, aliases, completion keys, and evidence together while preserving coherent completed own-listing progress.
- Helper stdout now uses stream-level UTF-8 decoding, preserving arbitrary multibyte chunk boundaries while retaining UUID correlation and the one-line JSON protocol.
- SKU selection establishes or reuses the opened item identity and rejects every subsequently observed conflicting stable ID with `UI_CONTRACT_CHANGED` before evidence capture.
- Search submit and semantic scrolling capture the pre-action result context, require a marker/signature transition, and then require three equal observations. Polling remains 250 ms with a 15-second deadline.
- Detail polling tolerates temporary search/empty/profile-miss snapshots until the deadline while propagating login and challenge stops immediately.
- Search-card overlap now includes stable AX card/action paths and a per-snapshot duplicate occurrence index. The new sanitized synthetic boundary fixture proves an identical new card receives the next rank while unchanged paths remain overlap.
- Opening a result retains the query and exact semantic result-context signature. Accessible back requires that same context for three consecutive observations; stable unrelated and empty lists time out, while a transitional sequence followed by the original context succeeds.

### Verification

- Focused checkpoint/helper/selector/driver run: PASS, 65 tests, 0 failures.
- `pnpm test:collector`: PASS, 74 tests, 0 failures.
- `pnpm typecheck`: PASS for API, web, and collector projects.
- `git diff --check`: PASS.
- Fix Round 1 changed-file public audit: PASS for all implementation, test, fixture, and report changes.
- Full `pnpm audit:public`: unchanged nonzero baseline caused only by the three historical local paths documented above.
- Swift production and XCTest source parse: PASS.
- Swift 5 production typecheck with warnings as errors: PASS.
- Strict Swift 6 production typecheck with complete concurrency and warnings as errors: PASS.
- Direct helper build for `arm64-apple-macosx12.0`: PASS.
- Direct read-only helper protocol probe: one UUID-correlated `ACCESSIBILITY_PERMISSION_REQUIRED` response line and zero stderr bytes; no permission prompt or UI challenge was triggered.
- `swift test --package-path apps/collector-macos`: blocked before test discovery by the unchanged unwritable default module cache and Apple Swift 6.3.3 compiler versus 6.3.2 SDK mismatch.

### Self-Review

- Rechecked every helper timeout, malformed line, process exit, concurrent rejection, and exactly-one-restart path; no raw stderr or unsafe helper message is exposed.
- Rechecked checkpoint aliases at fresh, paused, resumed, missing-ID, and complete boundaries. Unresolved identities are rank-scoped internal identities, never treated as Taobao IDs, and never accepted in complete reports.
- Rechecked search, detail, SKU, scroll, and back deadlines for 250 ms polling, a 15,000 ms maximum, and three equal stable observations where required.
- Rechecked selectors and actions for coordinate, geometry, DOM, OCR, and brittle global-text identity use; none was added.
- Rechecked evidence capture ordering: a conflicting item ID fails before parsing or screenshot capture, and generated evidence remains one collision-resistant flat PNG filename.

### Fix Round 1 Concerns

- The new result-query marker and duplicate-boundary fixture are minimal sanitized synthetic profile data. Accessibility permission remains unavailable, so Task 14 must validate or replace them against a live sanitized Taobao Desktop 2.4.5 build 15 snapshot.
- SwiftPM XCTest remains unavailable on this host for the documented compiler/SDK mismatch; all available direct Swift checks pass.
- The full public audit remains nonzero only for the three unrelated pre-existing historical-plan paths; the Fix Round 1 changed-file audit passes.

## Fix Round 2

### RED Evidence

- Duplicate continuity: the focused merge contract did not exist because overlap was embedded in the driver and depended on viewport-local occurrence ordinals. The reviewed `A1,A2 -> A2,A3` sequence therefore changed the shared `A2` key between snapshots and could append the second viewport incorrectly.
- Fixture path validity: the recursive invariant failed on both search fixtures. `search-result-query-marker` advertised `[0,1,4]` at child index `0`, and selector action paths such as `[0,1,0,0]` could not resolve through `children[index]`.
- Missing-ID rollback: after an own item received search rank `1`, a later unresolved card raised `MISSING_ITEM_ID`, then report parsing failed with `searchRanks must reference positions for the same platformItemId`.
- Repeated query: a loading selector miss followed by the original query/results exhausted the 15-second deadline because every final signature still had to differ from pre-submit state.
- Blank search start: a page with a valid semantic search field but no result container failed before `setValue` because pre-submit result context was mandatory.
- The no-transition repeated-query control already timed out at exactly 15 seconds, establishing the stale-state behavior that had to remain unchanged.

### GREEN Evidence

- Removed viewport-local occurrence ordinals from selector output and persistent card identity.
- Added a pure viewport merge using semantic card content plus stable AX action path. It finds maximal strict suffix/prefix overlap, appends only previously unseen strict occurrences, preserves `A1,A2,A3`, and adds nothing for unchanged or reordered known sibling occurrences.
- Search aggregation and later rank location now share the same merge behavior, while unchanged nonterminal scrolling still raises a typed no-progress contract error.
- Repaired every path in both search fixtures so each node path recursively equals its parent path plus child index. A reusable test scans all six committed AX fixtures and resolves every selected search action path back to the intended `AXLink` node.
- Missing-ID rollback clears `searchRanks` on every report item before removing search positions and search-discovered competitors. Completed own items, SKU evidence, and Task 6 checkpoint invariants remain intact.
- Pre-submit search context is optional. Post-submit transition is now a one-way latch set by a selector miss/loading snapshot or any valid context change; after latching, three equal final query/result observations may match the original signature.
- Login and challenge checks remain outside transition recovery and propagate immediately. A repeated query with no observed transition still consumes the exact 15,000 ms deadline at 250 ms intervals.

### Verification

- Focused checkpoint/fixture/helper/continuity/selector/driver run: PASS, 74 tests, 0 failures.
- `pnpm test:collector`: PASS, 83 tests, 0 failures.
- `pnpm typecheck`: PASS for API, web, and collector projects.
- Fix Round 2 changed-file public audit: PASS for all implementation, test, fixture, and report changes.
- `git diff --check`: PASS.
- Swift production and XCTest source parse: PASS.
- Swift 5 production typecheck with warnings as errors: PASS.
- Strict Swift 6 production typecheck with complete concurrency and warnings as errors: PASS.
- Direct helper build for `arm64-apple-macosx12.0`: PASS.
- Direct read-only helper protocol probe: one UUID-correlated `ACCESSIBILITY_PERMISSION_REQUIRED` response line and zero stderr bytes; no permission prompt or UI challenge was triggered.

### Self-Review

- Verified strict overlap uses semantic content plus action path and does not use geometry, coordinate, OCR, DOM, or viewport-local ordinals.
- Verified a distinct duplicate with a new stable action path survives, while exact and reordered known occurrences cannot manufacture ranks.
- Verified every committed synthetic AX node path and selected action path through the same child-index semantics used by the Swift helper.
- Verified missing-ID rollback order: rank references clear before positions, search-discovered items are removed consistently, own completion/evidence remains, and the persisted checkpoint passes semantic validation.
- Verified the transition latch is action-local, never latches from elapsed time alone, permits repeated-query restoration only after an observable miss/change, and preserves immediate typed stop propagation.
- Rechecked the five Round 1 fixes: rank-scoped unresolved identities, wrong-item SKU rejection, split UTF-8 decoding, detail transition tolerance, and exact back-context verification remain covered and passing.

### Fix Round 2 Concerns

- Search and duplicate-boundary fixtures remain minimal sanitized synthetic data because Accessibility permission is unavailable. Task 14 must validate or replace them against a live sanitized Taobao Desktop 2.4.5 build 15 snapshot.
- SwiftPM XCTest remains unavailable on this host for the documented compiler/SDK mismatch; all requested direct Swift checks pass.
- The repository-wide public audit baseline still contains the three unrelated historical-plan paths documented above; the Fix Round 2 changed-file audit passes.

## Fix Round 3

### RED Evidence

- A contract-valid real AX fixture was reordered from semantic sequence `A,A,B` to `B,A,A`, then every descendant path was recursively regenerated using the Swift helper's `parent.path + child index` rule. The existing path-only reconciliation returned five cards instead of preserving the original three ranks.
- A duplicate-count permutation from `A,A,B,B` to `B,A,B,A` likewise appended two existing occurrences because regenerated sibling paths made them appear new.
- The existing shifted duplicate boundary control remained `A1,A2 -> A2,A3`, establishing that a strict path overlap still had to append exactly the new `A3` occurrence.

### GREEN Evidence

- Search-card reconciliation now compares semantic multisets, including duplicate counts, before path-based append. Equal multi-class multisets are deterministic no-progress permutations even when every sibling path has been regenerated.
- Exact unchanged viewports append nothing. Equal single-class duplicate windows with no strict overlap are also treated as ambiguous no progress; when strict suffix/prefix path continuity exists, only the non-overlapping tail is appended.
- Mixed windows retain maximal strict suffix/prefix overlap, so `A,B,C -> B,C,D` appends only `D`, and shifted duplicate boundaries retain `A1,A2,A3` exactly.
- Action paths remain execution locators, not product identities. The probes resolve retained card locators only against the snapshot that supplied each card and do not reuse stale paths after a viewport change.
- This policy deliberately prefers stopping through the existing explicit no-progress/end handling when equal semantic evidence cannot distinguish a reorder from progress, instead of inventing ranks.

### Verification

- Focused AX-fixture/continuity/selector/driver run: PASS, 31 tests, 0 failures.
- `pnpm test:collector`: PASS, 85 tests, 0 failures.
- `pnpm typecheck`: PASS for API, web, and collector projects.
- Fix Round 3 changed-file public audit: PASS for all four implementation, test, and report changes.
- `git diff --check`: PASS.
- Swift production and XCTest source parse: PASS.
- Swift 5 production typecheck with warnings as errors: PASS.
- Strict Swift 6 production typecheck with complete concurrency and warnings as errors: PASS.
- Direct helper build for `arm64-apple-macosx12.0`: PASS.
- Direct read-only helper protocol probe: one UUID-correlated `ACCESSIBILITY_PERMISSION_REQUIRED` response line and zero stderr bytes; no permission prompt or UI challenge was triggered.

### Self-Review

- Verified semantic multiset comparison preserves duplicate counts and is independent of sibling order and regenerated AX paths.
- Verified strict overlap still uses semantic content plus stable action path, never viewport-local occurrence indexes, geometry, coordinates, OCR, or DOM assumptions.
- Verified each merged action path resolves in its source AX snapshot and stale locators are not carried forward as current viewport actions.
- Rechecked shifted duplicates, exact unchanged viewports, multi-class permutations, duplicate-count permutations, and mixed true-new-card windows.
- Rechecked all Round 1 and Round 2 probes through the full collector suite; Task 6 checkpoint behavior remains covered and passing.

### Fix Round 3 Concerns

- Equal semantic multisets without conclusive strict continuity are intentionally treated as no progress. This may conservatively stop collection when indistinguishable products genuinely replace one another, but it cannot fabricate ranks.
- Search fixtures remain minimal sanitized synthetic data because Accessibility permission is unavailable. Task 14 must validate or replace them against a live sanitized Taobao Desktop 2.4.5 build 15 snapshot.
- SwiftPM XCTest remains unavailable on this host for the documented Apple Swift 6.3.3 compiler versus 6.3.2 SDK mismatch; all requested direct Swift checks pass.
