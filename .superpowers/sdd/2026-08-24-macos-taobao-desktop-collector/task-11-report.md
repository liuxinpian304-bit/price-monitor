# Task 11 Report: Desktop evidence upload and report ingestion

## Status

Implemented Task 11 on base commit `96e8a4bcccabba5339b083c2237af8ef940ea1c3`.

The API now accepts authenticated, content-addressed PNG evidence and ingests terminal desktop reports in one PostgreSQL transaction. Report acceptance is durable and concurrent-safe, and an identical accepted report returns its original summary without creating duplicate positions, candidates, snapshots, or issues.

## Delivered behavior

### Evidence upload

- Added `PUT /api/collector-agent/jobs/:runId/evidence/:sha256`.
- Authentication runs in a route guard before Multer parses or buffers multipart data.
- Multer uses memory storage with an independent one-file, 2 MiB limit.
- Only canonical lowercase 64-character SHA-256 path digests and `image/png` files are accepted.
- The store verifies the PNG signature, recomputes the digest, rejects traversal and symbolic-link redirection, and writes with an exclusive temporary file, `fsync`, and atomic rename.
- Evidence is stored beneath `work/collector-evidence/<runId>/<sha256>.png`; local paths never enter reports, responses, errors, or database rows.
- A new object returns `201`; an already verified identical object returns `200` without rewriting it.
- A terminal run accepts only an idempotent repeat of an object that already exists and verifies for that run.

### Report endpoint and validation

- Added `POST /api/collector-agent/jobs/:runId/report`.
- The HTTP controller validates with `collectorReportSchema` before service use and never echoes rejected content.
- Authentication precedes body validation. Path/report run IDs, collector identity, run owner, run status, search limit, URL item IDs, claimed own-listing IDs, timestamps, terminal status, and all evidence references are bound before persistence.
- Task 10 pause reports are rejected with `422` and must use the pause endpoint.
- `SUCCEEDED` reports are rejected when they contain any Task 10 partial-failure or pause issue.
- All accepted timestamp spellings are canonicalized to UTC before persistence and idempotency comparison.
- Responses are `202` for first acceptance and `200` for an identical accepted report.
- Invalid tokens return `401`; wrong owner, wrong state, or conflicting terminal content returns `409`; payload limits return `413`; contract, hash, and evidence-reference failures return `422`; sanitized storage or transaction failures return `500`.

### Claimed ownership snapshot

- Added `CollectionRun.claimedOwnListingIds` and migration `20260825013000_snapshot_claimed_own_listings`.
- Task 3 claim persistence snapshots exactly the active own-listing IDs included in the claimed job inside the same serializable transaction.
- Ingestion validates against that durable snapshot, so later catalog edits cannot invalidate a legitimate in-flight report or expand the set of accepted own identities.
- Own identity comes only from a claimed `ownListingId`; shop and title text are never used to classify ownership.

### Transactional ingestion and idempotency

- The repository locks the `CollectionRun` row with `FOR UPDATE`, then rechecks ownership, collector identity, claimed own listings, status, and rank limit inside the transaction.
- Positions are upserted by `(collectionRunId, rank)` and preserve ranks `1..limit`, including duplicate item identities at different ranks.
- Competitors are upserted by `(monitoredModelId, providerKey, platformItemId)` with candidate decision reset to `PENDING` for Task 12.
- SKU snapshots use the Task 2 SHA-256 ingestion key over run ID, own/candidate identity, item ID, SKU ID, and canonical capture timestamp.
- Price components, confidence, promotions, stock, redacted attributes, and validated evidence keys are persisted exactly; no local path or raw evidence byte is stored.
- Issues use deterministic SHA-256 keys and remain idempotent.
- Positions, candidates, SKU snapshots, issues, counters, summary inputs, timestamps, and terminal run status commit together.
- A transaction failure rolls back all ingestion writes, leaves the run `RUNNING`, and records only `DESKTOP_REPORT_INGESTION_FAILED` with a fixed sanitized message outside the failed transaction.
- Concurrent submissions serialize on the run row. A terminal repeat verifies persisted report content and returns the original stable summary without writes.

## TDD evidence

Initial focused tests failed with missing ingestion/evidence modules and routes before implementation.

Independent review later identified four uncovered cases. Regression tests reproduced each failure before its fix:

- `SUCCEEDED` accepted an `ITEM_UNAVAILABLE` issue.
- An unauthenticated oversized evidence request returned `413` before authentication instead of `401`.
- Deactivating an own listing after claim caused a legitimate report to return `409`.
- Repeating the same valid report with `+08:00` timestamps returned `409`.

After implementation, the focused Task 11 suite passes all 24 tests, including real Nest HTTP interceptor ordering.

## PostgreSQL integration verification

The integration fixture uses random UUID-derived identifiers and deletes its run, model, agent, and evidence directory, avoiding fixed-value collisions with Task 2 fixtures.

The test claims a job, deactivates the claimed listing afterward, uploads two evidence objects, and concurrently ingests the same report twice, followed by a sequential repeat. The report contains:

- 50 contiguous positions with one item repeated across 49 ranks;
- two own SKU snapshots and four competitor SKU snapshots;
- one issue and two referenced evidence keys;
- valid non-UTC offset timestamps.

It verifies one 50-row position history, six snapshots, one candidate, one issue, exact price/evidence fields, correct own/candidate links, exact counters/status, the durable claim snapshot, and identical summaries from concurrent and sequential repeats.

The updated real PostgreSQL integration passed once as a focused command and again inside the full API suite.

## Verification

- Focused Task 11 tests: 24 passed, 0 failed.
- `pnpm test:api:portable`: 106 passed, 0 failed.
- `pnpm test:api`: 118 passed, 0 failed with PostgreSQL and Redis.
- `pnpm typecheck`: passed for API, web, and collector.
- `prisma validate`: passed.
- `git diff --check`: passed.

## Review

An independent uncommitted-diff review was run after the first complete implementation. All four findings were reproduced, fixed, and covered by regression tests. No rejected report body, token, item/account text, evidence bytes, or local path is logged or returned by the new paths.

## Commit

Requested commit message: `feat: ingest desktop SKU reports`

## Concerns

No known Task 11 functional concerns remain. Task 13 still owns the configurable 8 MiB JSON parser and broader API lifecycle configuration; the evidence route already has its required independent 2 MiB Multer limit.

## Fix Round 1

### Status and terminal semantics

- `SUCCEEDED` now requires no issues and exactly one own item for every durable claimed own-listing ID. Zero-own claims remain valid, while missing, unknown, and duplicate own-listing IDs are rejected.
- Pause and server-only issue codes cannot enter through the report endpoint. `PARTIAL_FAILED` requires durable progress plus a runner completion issue; `FAILED` requires no durable progress plus a runner fatal issue.
- Focused tests cover every Task 10 runner completion/fatal code, zero-own success, relabeled success, startup failures, competitor-only pseudo-progress, and all non-success issue codes on `SUCCEEDED`.

### Durable replay receipt

- Added `CollectionRun.desktopReportDigest` and `CollectionRun.desktopIngestionSummary` with migration `20260825023000_add_desktop_report_receipt`.
- The full validated report is timestamp-normalized, recursively ordered with locale-independent code-unit key ordering, and SHA-256 digested. The digest includes app version, URLs, ranks, zero-SKU metadata, issues, promotions, attributes, prices, and evidence references.
- First acceptance stores the digest and original summary in the same transaction as all report history and terminal state. Concurrent and sequential identical replays return that stored summary; any changed accepted field returns `409`.
- A terminal row created before receipt persistence can be upgraded once under the run-row lock only after its durable legacy projection matches. The upgrade stores the incoming full digest and a summary reconstructed from the original run counters and snapshot IDs; subsequent replays use only the exact receipt.

### HTTP ordering and bounds

- Nest default parsing is disabled in the API bootstrap. An explicit pre-parser middleware authenticates the report route before JSON buffering, including Express-equivalent case-insensitive route spellings.
- Invalid or missing tokens win over malformed and oversized report bytes with `401`; authenticated oversized JSON returns `413`; authenticated malformed JSON returns a sanitized `422` without body text.
- Report-only contract bounds now cover every persisted VARCHAR-shaped identifier/text field and PostgreSQL `Int`, including combined public discounts. Outbound job validation remains compatible with existing unbounded catalog URL and term storage.

### Evidence publication and state serialization

- Evidence roots and run directories are checked by physical canonical path and device/inode identity. Symlinked ancestors and parent replacement are rejected.
- Publication uses a unique fsynced temporary file plus atomic hard-link create-if-absent. Independent store instances produce exactly one `created: true`; a loser verifies the existing bytes and returns `created: false`.
- Evidence upload holds a PostgreSQL `FOR UPDATE` run-row lock while rechecking owner/state and writing. A concurrent terminal transition waits; terminal runs permit only a verified existing-object replay.
- If the database commit fails after a content-addressed file is published, the unacknowledged same-run object is retained for a safe retry. Failed filesystem publication removes its own temporary or newly linked inode.

### RED evidence

- Terminal semantics and persistence bounds initially produced five focused failures.
- Full-report replay tests initially accepted changed app version, URL, and zero-SKU metadata, and did not preserve the original summary.
- Invalid oversized report JSON initially returned `413` before authentication.
- Two store instances both reported creation; a symlinked root and replaced parent were initially accepted.
- A concurrent run transition initially overtook a blocked evidence write.
- Terminal changed-evidence replay initially returned evidence validation rather than digest conflict.
- Final independent review regressions reproduced three portable failures: Unicode key ordering, uppercase route authentication ordering, and outbound job-contract compatibility. The PostgreSQL pre-receipt replay returned `409` before the locked upgrade was added.

### GREEN verification

- Focused portable Task 11 tests: 47 passed, 0 failed.
- Focused real PostgreSQL Task 11 integration: 9 passed, 0 failed, including concurrent first ingestion, pre-receipt upgrade, exact replay conflicts, and blocked evidence/state serialization.
- Task 4/config overflow tests: 16 passed, 0 failed.
- `pnpm test:api:portable`: 116 passed, 0 failed.
- `pnpm test:api`: 136 passed, 0 failed against the requested PostgreSQL and running Redis.
- `pnpm typecheck`: passed for API, web, and collector.
- `prisma validate`: passed; `prisma migrate status`: five migrations found and database schema up to date.

### Fix Round 1 self-review

- Re-read all six findings against the final diff and Task 10 runner status production.
- Verified rejected input, tokens, account/item text, evidence bytes, and local paths are absent from responses and new logging paths.
- Verified receipt comparison precedes terminal evidence lookup, and report evidence checks remain inside the locked ingestion transaction.
- Verified Task 3 claimed-own-listing persistence and both Task 11 migrations remain included.
- No known Task 11 functional concern remains. The one-time legacy receipt upgrade necessarily compares the durable projection available from the pre-receipt implementation; after that locked upgrade, all replay decisions use the canonical full-report digest.
