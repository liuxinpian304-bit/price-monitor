# Final Review Fix Report

Date: 2026-08-26

Authoritative findings: `final-review-1.md`

Implementation base: `e7224d2d`

## Result

All 1 Critical, 8 Important, and 2 Minor findings were reproduced or verified
against the code and addressed in one fix wave. Tests use fixtures, fakes, an
isolated PostgreSQL schema, and local Redis. No real Taobao page, account, shop
data, WeCom webhook, message, or credential was used.

The plan's live completion gate is intentionally still open. The supervised
three-result and first-50 Taobao runs, selector-profile acceptance, and one
separately approved WeCom send were not performed.

## Finding Resolution

### Critical: conservative promotion evidence

- Added optional, backward-compatible `activityPriceInclusion` values
  `INCLUDED`, `EXCLUDED`, and `UNKNOWN` to promotion evidence.
- The macOS parser retains every visible public promotion. Unsupported public
  labels are persisted as incomplete `UNKNOWN_PUBLIC_PROMOTION` evidence.
- Activity/payable-price promotions are `UNKNOWN` unless inclusion is proven.
  Unknown inclusion is never subtracted and cannot produce `CONFIRMED` price
  confidence, preventing a false confirmed-low alert.
- Added parser, shared pricing, contract, and alert-boundary coverage for
  ambiguous promotions and activity payable price plus coupon evidence.

### Important 1: ownership-fenced claimed-run recovery

- Persisted the exact claimed job in nullable `CollectionRun.claimedJob` so a
  recovered run uses the original durable checkpoint contract even if catalog
  settings change.
- Added an authenticated release route. Only the owning agent may requeue its
  `RUNNING` run; ownership and claimed job remain attached.
- Added a 90-second heartbeat lease. Only the same agent can reclaim its stale
  run; another agent cannot steal either live or released work.
- The worker releases on graceful interruption, runner construction failure,
  collection failure, invalid report/checkpoint, and exhausted evidence/report
  upload paths without deleting the durable checkpoint.
- PostgreSQL integration coverage proves exact-job recovery, same-owner stale
  reclaim, live-work fencing, and cross-agent rejection.

### Important 2: durable alert and notification reconciliation

- Added durable evaluation token, lease, attempt, completion, and sanitized
  error fields on `CollectionRun`.
- Added startup and 30-second interval reconciliation with overlap prevention.
  Evaluation and notification outboxes survive process restart and retain retry
  ceilings.
- Added `AMBIGUOUS` notification state. Fetch/response-body loss after a WeCom
  POST never triggers another blind POST.
- Self-review found and fixed the process-crash variant: an abandoned `SENDING`
  batch is row-locked, recorded as `WECOM_DELIVERY_AMBIGUOUS`, and never replayed
  from either interval reconciliation or direct ingestion replay.
- Definite decoded WeCom rejection remains retryable; missing configuration and
  delivery failures remain sanitized and durable.

### Important 3: persisted check-time reconciliation

- Runtime schedule settings now include persisted `checkTimes`.
- Scheduler reconciliation lists persisted IDs, removes obsolete
  `tmall-collection-*` entries, preserves unrelated schedules, and upserts only
  the desired Shanghai-time schedules.
- Disable/manual/provider changes remove monitor schedules. Redis integration
  coverage changes the persisted time set and verifies obsolete ID removal.

### Important 4: explicit search termination

- Added backward-compatible `LIMIT_REACHED` and `END_MARKER` contract values,
  nullable Prisma persistence, API report output, and report UI rendering.
- Successful short searches require a verified end marker. Successful
  limit-reached reports require the exact requested position count. Legacy full
  reports without the new field remain valid.
- The macOS driver throws when it reaches neither the requested limit nor a
  verified end marker. Truncated/interrupted reports remain incomplete.

### Important 5: authoritative own baseline

- Added nullable `ownBaselineSnapshotId` with a same-run persistence check and
  foreign key.
- Alert evaluation persists the exact selected own snapshot or explicitly
  persists no baseline for missing/ambiguous cases.
- Report comparisons and price filters consume that exact snapshot ID instead
  of a separate text matcher. Attribute-only punctuation/spacing normalization
  is covered by unit and PostgreSQL integration tests.

### Important 6: deterministic diagnostics

- Swift diagnosis now reports app installation, running state, Accessibility,
  Screen Recording, version/build, and front-window state without prompting or
  writing evidence.
- Added injectable `CGPreflightScreenCaptureAccess` coverage and typed recovery
  codes end to end.
- TypeScript checks app presence and both permissions before version/window/login
  state. All live UI actions remain replaced by fakes in tests.

### Important 7: mixed-title SKU exclusions

- Excluded aliases such as M1/MV1 are applied to the selected SKU rather than a
  shared multi-variant title.
- Offer-wide risk terms remain active on titles.
- Tests accept an exact selected 7506 bare SKU on a 7506/M1/MV1 title while
  rejecting selected M1/MV1 and offer-wide risk terms.

### Important 8: production bind guard

- Production binds now use `node:net.isIP` and canonical IPv6 handling.
- Only `localhost`, IPv4 `127/8`, and `::1` are accepted without explicit
  opt-in. IPv4/IPv6 wildcards and other non-loopback addresses are rejected.

### Minor 1: out-of-stock evidence

- Selected `OUT_OF_STOCK` SKU rows and price evidence are retained.
- Existing alert eligibility still rejects out-of-stock snapshots.

### Minor 2: evidence popup

- The evidence window opens synchronously before the protected async fetch,
  clears its opener, navigates to the verified blob, and closes on error.
- Desktop and 390px mobile browser tests exercise the protected PNG popup and
  contained report layout.

## Migration

Added:

`prisma/migrations/20260826143000_harden_collector_pilot_readiness/migration.sql`

The migration adds only nullable/backward-compatible fields except the new
evaluation-attempt counter, which has a default of zero. It adds the
`AMBIGUOUS` notification enum value, nullable search-termination enum field,
indexes, and the nullable baseline foreign key.

An isolated schema named `final_fix_20260826` was used. The database adapter now
validates the `schema` query parameter and applies it to both Prisma-generated
queries and raw SQL, preventing integration tests from leaking into `public`.

## Verification

The bundled Node runtime path was prepended because the desktop shell exposed
the bundled `pnpm` wrapper but omitted its sibling `node` binary from `PATH`.
This was a host PATH issue and required no repository change.

Database gates:

```text
DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=final_fix_20260826' pnpm db:migrate
PASS - all 8 migrations applied to the isolated schema.

DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=final_fix_20260826' pnpm db:validate
PASS - prisma/schema.prisma is valid.

DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=final_fix_20260826' pnpm db:generate
PASS - Prisma Client 7.9.1 generated.

DATABASE_URL='postgresql://price_monitor:price_monitor_dev@127.0.0.1:5433/price_monitor?schema=final_fix_20260826' pnpm exec prisma migrate status
PASS - 8 migrations found; database schema is up to date.
```

Automated gates:

```text
pnpm test:portable
PASS - local env 4/4; config 19/19; contracts 18/18; portable API
217/217; collector 153/153; web 38/38.

DATABASE_URL=<isolated-schema-url> REDIS_HOST=127.0.0.1 REDIS_PORT=6380 pnpm verify
PASS - full API 245/245; collector 153/153; web 38/38; E2E 3/3;
typecheck and production build passed. The same run also passed local-env,
config, and contract suites.

DATABASE_URL=<isolated-schema-url> REDIS_HOST=127.0.0.1 REDIS_PORT=6380 pnpm test:browser
PASS - desktop and mobile-390 projects, 2/2.

pnpm audit:public
PASS - Public repository audit passed.

git diff --check
PASS - no whitespace errors.
```

Focused TDD included red-to-green runs for conservative pricing, claimed-run
recovery, evaluation restart, ambiguous WeCom response loss, abandoned
`SENDING` reconciliation, persisted schedule changes, termination validation,
baseline identity, diagnostics, mixed-title matching, bind rejection,
out-of-stock retention, and popup behavior.

## Swift Host Result

```text
xcode-select -p
/Library/Developer/CommandLineTools

swift --version
swift-driver version: 1.148.6 Apple Swift version 6.3.3
(swiftlang-6.3.3.1.3 clang-2100.1.1.101)
Target: arm64-apple-macosx26.0

swift build --package-path apps/collector-macos
PASS - Build complete! (0.19s).

swift test --package-path apps/collector-macos
BLOCKED - `no such module 'XCTest'` at
apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift:2.
```

The executable build is verified. Full Swift/XCTest success cannot be claimed
on this Command Line Tools-only host; full Xcode with XCTest remains required.

## Self-Review

The complete diff was reviewed against every authoritative finding and the
plan's safety boundaries. The abandoned `SENDING` duplicate-POST risk found in
self-review was fixed and covered before final aggregate verification.

Auth ordering, evidence confinement, report/evidence idempotency, retry ceilings,
and live-pending documentation remain intact. Shared TypeScript/runtime scripts
retain Windows-compatible APIs and path handling.

The ignored transient
`.superpowers/sdd/2026-08-24-macos-taobao-desktop-collector/task-14-browser-seed.ts`
was not staged or committed. No live evidence was created or committed.

After the final commit, `git status --short` produced no output.

## Residual Concerns

- Full Xcode/XCTest is unavailable on this host, so Swift unit tests remain an
  explicit blocker.
- The supervised three-result run, first-50 or verified-page-end acceptance,
  real selector-profile check, and separately approved WeCom pilot send remain
  mandatory live gates. This report does not claim them.
- Production build succeeds with a Vite warning for a 1,338.94 kB minified JS
  chunk (423.93 kB gzip). This is a performance warning, not a failed gate.
