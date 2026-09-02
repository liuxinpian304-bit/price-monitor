# Final fix report

Date: 2026-08-29

Baseline: `c468a9f32c81828275d1424ff8a47e61ee3cdb9d`

Implementation commit: `2376c52e30b1b062e40f1a79263ea69db1919848`

## Status

All six Important findings and the one Minor finding in `final-review-findings.md` are fixed. The changes are limited to the reviewed SKU-gap behavior, its persistence protocol, migration, test harnesses, and focused regression coverage.

## Finding mapping

1. **Important 1 - component quantity ownership**
   - Package-token quantities are assigned to that explicit component.
   - A quantity dimension changes a component only when its dimension clearly identifies exactly one core or paid-accessory component.
   - Generic, malformed, conflicting, fractional, or signed quantity evidence emits an `UNKNOWN` component, which keeps comparison in `REVIEW`.
   - Added production-style coverage with no explicit component list, including paid-accessory quantity differences.

2. **Important 2 - material attributes are not components**
   - Version, region, national-market, warranty, and equivalent supported dimensions are excluded from component inference.
   - They remain available through the existing `materialAttributes` path.
   - Added coverage for `版本`, `地区`/`国行`, and `保修` dimensions.

3. **Important 3 - mandatory exclusions**
   - Centralized the non-overridable mandatory exclusion list.
   - Added `维修`, `空盒`, and `单独配件` for both title and selected-SKU text.
   - Optional model configuration cannot remove these exclusions.

4. **Important 4 - partial own SKU enumeration fails closed**
   - Added one authoritative `deriveOwnCatalogCompleteness` result shared by alert evaluation and report aggregation.
   - Completeness now requires every claimed own listing to be collected and no attributable own detail blocker.
   - `SKU_ENUMERATION_INCOMPLETE`, selection mismatch, price instability, item unavailability, and global collection-contract failures prevent `MISSING_OWN` conclusions.
   - Existing persisted `MISSING_OWN` rows are projected as `REVIEW` with `OWN_CATALOG_INCOMPLETE` when the authority reports incomplete.
   - PostgreSQL integration coverage proves partial own enumeration produces no missing group or alert.

5. **Important 5 - historical runs are never backfilled or notified**
   - Added nullable `CollectionRun.alertEvaluationVersion` with no default and no data backfill.
   - Only newly accepted compatible desktop reports receive `sku-gap-report-v1`.
   - Candidate selection, atomic claim, success completion, and failure completion all require that exact version.
   - Terminal replays do not stamp historical runs; integration coverage confirms an old-style run remains `null`.

6. **Important 6 - own ranked SKUs appear in the first-50 price board**
   - Price-board input now includes every ranked SKU, including `OWN` rows.
   - Confirmed-low, missing-own, and review lists remain competitor-only.

7. **Minor 1 - clone decision reasons**
   - Comparison decisions return a cloned reasons array.
   - Added mutation-isolation coverage.

## TDD evidence

- Component evidence RED: 7 focused failures exposed accessory quantities collapsing, generic ownership mutating the core, malformed quantities not becoming unknown, and material dimensions becoming components. GREEN: `sku-component-evidence.spec.ts`, 17/17 passed.
- Mandatory exclusions RED: a `维修` title remained `SIGNED`. GREEN: `sku-combination.spec.ts`, 15/15 passed, including title and selected-SKU cases.
- Completeness authority RED: focused test failed to load the not-yet-created module. GREEN: `own-catalog-completeness.spec.ts`, 4/4 passed.
- Shared report fail-closed behavior RED: incomplete own enumeration still reported complete; the expanded regression then produced one missing group instead of zero. GREEN: `collection-report-aggregation.spec.ts`, 9/9 passed, and query-service focused tests passed.
- Evaluation protocol RED: repository test failed because the version module and predicates did not exist. GREEN: `prisma-run-alert-evaluation.repository.spec.ts`, 1/1 passed.
- Ranked own rows and reasons isolation RED: 2 focused failures showed an empty own price board and caller mutation changing returned reasons. GREEN: the combined focused suites passed 27/27.
- PostgreSQL regression GREEN: 18/18 integration tests passed, including partial own enumeration, new-report version stamping, and legacy-run null preservation.

## Verification

- `pnpm verify`: PASS.
  - local environment 4/4; config 22/22; contracts 28/28; API 322/322; collector 178/178; web 43/43; E2E 6/6.
  - TypeScript typecheck and Vite production build passed.
  - Vite emitted only its non-failing existing large-chunk warning.
- `pnpm audit:public`: PASS (`Public repository audit passed.`).
- `git diff --check` and staged `git diff --cached --check`: PASS.
- `pnpm db:generate`: PASS.
- `pnpm db:validate`: PASS.
- PostgreSQL migration deployment: PASS; migration `20260828173000_add_run_alert_evaluation_version` applied.
- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`: PASS (`No difference detected.`).
  - The first parity run exposed PostgreSQL's 63-byte index-name truncation. The schema now explicitly maps to the actual database index name; the final parity run is clean.
- Focused PostgreSQL integration command over desktop ingestion, alert persistence, and schema upgrade suites: PASS, 18/18.
- `swift build -c release --package-path apps/collector-macos`: PASS (`Build complete!`). The first sandboxed attempt could not access SwiftPM user caches; the approved production build and final cached rerun both passed.

## Preserved invariants

Exact structured combinations, detail-SKU price provenance, the one-fen threshold, transaction atomicity, macOS/Windows collector compatibility, and Enterprise WeChat default-deny behavior remain covered by the passing full suite.

## Remaining limitations

- Swift XCTest was not run and is not claimed as passed; the required compatible-SDK Swift production build passed.
- No live Taobao account collection or live Enterprise WeChat delivery was performed. Automated collector/E2E coverage passed, and live sending remains default-deny.
