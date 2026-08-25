# Task 14A Automated Delivery Report

## Status

**AUTOMATED COMPLETE / LIVE PENDING**

This delivery implements and verifies the automated Task 14 scope. It does not
claim that a real Taobao desktop collection pilot or a real WeCom send has
completed. No live shop data, account data, screenshot, pairing token, or
WeCom credential was created or committed.

## Delivered

- Added ADMIN-only collection-run list, detail, and evidence endpoints with
  stable typed pagination responses, completion/notification data, database-side
  SKU filters, and rank-ordered positions.
- Replaced eager child loading with summary-only run selects plus aggregate
  counts. Run pages are capped at 100 records; positions, issues, and SKUs use
  independent capped pages. The large PostgreSQL fixture covers 205 runs, 151
  positions, 221 SKUs, 140 issues, selective filters, duplicate item ranks, and
  a valid zero-fen own baseline without misstating totals or completion.
- Added evidence ownership verification before storage access. Evidence accepts
  only a lowercase 64-character SHA-256 digest and returns a private,
  no-store PNG response without exposing local paths.
- Added the `/runs` and `/runs/:runId` operating views, including incomplete
  completion labels, independent SKU rows, prices, stock, rank, match result,
  issues, evidence controls, and paused-run recovery guidance. Requeue is
  visible only for login and platform-challenge pauses.
- Added explicit first-load, permission, not-found, network-error, and
  successful-empty states. A failed initial detail request no longer renders a
  fabricated `0 / 50` report; prior data is retained only after a successful
  response for the same query.
- Added a token-free admin-session snapshot store. A fresh protected view now
  performs exactly one bearer-authenticated retry after unlock and does not
  reload or loop after a rejected token.
- Added the `淘宝桌面版采集器` settings label, assembled-runtime health wording,
  responsive horizontal table behavior, and a deterministic Playwright fixture
  for desktop and 390px viewports.
- Added the macOS collector operator guide and updated README/recovery/operator
  status wording to distinguish assembled code from unaccepted live behavior,
  describe both desktop and external-provider paths, and require action-time
  confirmation before a first real WeCom send.
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
| Focused report/controller tests | 12 / 12 passed |
| Large PostgreSQL report fixture | 1 / 1 passed |
| Focused report web tests | 4 files, 25 / 25 passed |
| `pnpm test:api:portable` | 203 / 203 passed |
| `pnpm test:api` with a fresh isolated PostgreSQL schema and local Redis | 230 / 230 passed |
| `pnpm test:web` | 11 files, 37 / 37 passed |
| `pnpm test:browser` | desktop and 390px, 2 / 2 passed |
| `pnpm test:e2e` | 3 / 3 passed |
| `pnpm typecheck` | passed |
| `pnpm db:validate` | passed with placeholder database configuration |
| `pnpm db:generate` | passed |
| `pnpm audit:public` | passed |
| `pnpm verify` | passed: local 4, config 17, contracts 17, API 230, collector 146, web 37, E2E 3, typecheck, production build |

`pnpm test:browser` builds and starts only a local preview server, then intercepts
local `/api` requests with sanitized fixtures. It verifies `/runs` and one detail
view at desktop and 390px widths, the visible `47 / 50，未完成` state, one
post-unlock bearer retry without document reload, contained table scrolling,
no body overflow, non-overlapping filter controls, and no unexpected console
errors. The expected initial 403 is asserted exactly once. No screenshot or
trace is committed. A first sandboxed portable API attempt failed only because
loopback binding returned `EPERM`; the same command passed 203 / 203 with local
loopback permission.

## Environment Gaps

- `swift test --package-path apps/collector-macos` remains blocked on this host.
  With local compiler cache access, test compilation fails at
  `import XCTest` with `no such module 'XCTest'`. `xcode-select -p` is
  `/Library/Developer/CommandLineTools` and `xcrun --find xctest` cannot find
  the tool. A compatible full Xcode installation must be selected before Swift
  acceptance can be claimed.
- `pnpm run doctor` exits non-zero because this worktree deliberately has no
  local `.env` and no configured Mac collector diagnostics. It reports Node
  24.19.0, pnpm, Docker, and Docker Compose as available, then reports
  `MISSING macOS collector diagnostics` and `MISSING .env`.

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
