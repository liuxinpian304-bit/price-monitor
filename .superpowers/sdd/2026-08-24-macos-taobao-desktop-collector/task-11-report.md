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
