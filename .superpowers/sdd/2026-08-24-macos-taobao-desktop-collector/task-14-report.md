# Task 14A Automated Delivery Report

## Status

**AUTOMATED COMPLETE / LIVE PENDING**

This delivery implements and verifies the automated Task 14 scope. It does not
claim that a real Taobao desktop collection pilot or a real WeCom send has
completed. No live shop data, account data, screenshot, pairing token, or
WeCom credential was created or committed.

## Delivered

- Added ADMIN-only collection-run list, detail, and evidence endpoints with
  typed responses, completion/notification data, SKU filters, and rank-ordered
  positions.
- Added evidence ownership verification before storage access. Evidence accepts
  only a lowercase 64-character SHA-256 digest and returns a private,
  no-store PNG response without exposing local paths.
- Added the `/runs` and `/runs/:runId` operating views, including incomplete
  completion labels, independent SKU rows, prices, stock, rank, match result,
  issues, evidence controls, and paused-run recovery guidance. Requeue is
  visible only for login and platform-challenge pauses.
- Added the `淘宝桌面版采集器` settings label, assembled-runtime health wording,
  responsive horizontal table behavior, and a working local API development
  script for the installed `tsx` CLI.
- Added the macOS collector operator guide and updated README/recovery/operator
  status wording to distinguish assembled code from unaccepted live behavior.
- Replaced the three legacy local-machine paths required by the public audit
  with portable placeholders.
- Closed automated deferred-risk coverage for aggregate safe-integer price
  overflow, collector persistence fixture isolation, and evidence/report resume
  states. A run with only a legacy aggregate counter cannot now be reported as
  rank-complete without persisted rank evidence.

## Automated Verification

All commands below used sanitized fixtures and local services only.

| Command | Result |
| --- | --- |
| Focused report query test | 5 / 5 passed |
| `pnpm test:api:portable` | 199 / 199 passed |
| `pnpm test:api` with isolated PostgreSQL and Redis | 225 / 225 passed |
| `pnpm test:web` | 11 files, 28 / 28 passed |
| `pnpm test:e2e` | 3 / 3 passed |
| `pnpm typecheck` | passed |
| `pnpm db:validate` | passed with isolated database configuration |
| `pnpm db:generate` | passed |
| `pnpm audit:public` | passed |
| `pnpm verify` | passed, including API, collector, web, E2E, and production web build |

The local API and web development servers were also started with an isolated
database and sanitized demo fixtures. Browser checks covered `/runs` and one
detail view at desktop and 390px widths: the supplied `47 / 50，未完成` case was
visibly incomplete, and the no-rank-evidence regression rendered
`0 / 50，未完成`; desktop and mobile controls did not overlap; mobile table
contents had horizontal overflow; and the page had no browser-console errors.
No screenshot was saved to the repository.

## Environment Gaps

- `swift test --package-path apps/collector-macos` remains blocked on this host.
  With local compiler cache access, package sources and the helper build, but
  test compilation fails with `no such module 'XCTest'`. The selected developer
  directory is Command Line Tools and `xcrun --find xctest` cannot find XCTest.
  A compatible full Xcode toolchain is required before Swift acceptance can be
  claimed.
- `pnpm run doctor` exits non-zero because this worktree deliberately has no
  local `.env` and no configured Mac collector diagnostics. It reports Node,
  pnpm, Docker, and Docker Compose as available.

## Live Acceptance Still Required

1. On an approved, registered, logged-in, unlocked Mac with Accessibility and
   Screen Recording permissions, run the supervised Sony MDR-7506 three-result
   pilot and stop on login loss, challenge, unexpected page state, or selector
   drift.
2. Run the supervised 50-result (or explicit earlier page-end) acceptance and
   manually inspect required ranks, all accessible SKUs, activity pricing,
   checkpoints, evidence confinement, and the report.
3. Obtain fresh action-time confirmation before one real WeCom pilot send, then
   verify deduplication without making any Taobao price changes.
4. Repeat acceptance with a compatible full Xcode installation; Windows and
   three-machine production sharding remain separate unaccepted work.

The commit SHA is reported by the final delivery response because a file cannot
reliably contain the hash of the commit that includes itself.
