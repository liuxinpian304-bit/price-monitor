# Task 10 Report: macOS Collector Agent

## Status

Implemented Task 10 from base commit `707523829cc65870a51a5715e740fe00ff033274`.

The collector now has strict environment configuration, a redacting authenticated API client, content-addressed evidence upload, one-job worker lifecycle, graceful signal handling at durable SKU boundaries, `diagnose`/`once`/`worker` CLI commands, and platform-gated portable verification.

The referenced `task-3-report.md` was absent from the worktree. Task 3 behavior was verified from `task-3-brief.md`, the committed controller/service source, and their tests.

## Configuration And Transport

- `COLLECTOR_PAIRING_TOKEN` must match `pmc_` followed by exactly 43 base64url characters, representing the Task 3 32-byte token.
- HTTP accepts canonical numeric loopback hosts and exact `localhost`; `localhost` is normalized to `127.0.0.1` before fetch. Remote HTTP, credentials, deceptive suffixes, shorthand/decimal/hex/octal IPv4, path prefixes, query strings, and fragments are rejected. Remote HTTPS is allowed.
- Relative helper and work paths resolve from the repository root even though pnpm runs the package script from `apps/collector`. The configured work directory must be a strict descendant of that root.
- Every request creates `AbortSignal.timeout(15_000)`. Failure bodies and fetch causes are discarded. Typed errors retain only safe method, route template, status, code, and transient metadata.
- All success responses are contract-validated before use. Task 11 contracts are isolated in the client and fake-fetch tested.

Exact client routes:

```text
GET  /api/health
POST /api/collector-agent/jobs/__collector_diagnose__/heartbeat
POST /api/collector-agent/jobs/claim
POST /api/collector-agent/jobs/:runId/heartbeat
POST /api/collector-agent/jobs/:runId/pause
PUT  /api/collector-agent/jobs/:runId/evidence/:sha256
POST /api/collector-agent/jobs/:runId/report
```

The diagnostic heartbeat probe treats authenticated `204`, `409`, or authentication-precedent `422` as a valid pairing result and never claims a job. Invalid pairing remains `401`.

## Evidence And Worker Lifecycle

- Evidence is deduplicated by `sha256:<64 lowercase hex>` and read only after lexical and realpath containment beneath the per-run directory.
- Reads use `O_NOFOLLOW`, require a regular PNG of at most 2 MiB, verify the PNG signature, and recompute the content hash before upload.
- Multipart uploads use field `evidence` and the lowercase hex digest in the Task 11 path. A key is marked uploaded only after the response acknowledges the identical full evidence key.
- Partially acknowledged evidence remains marked in memory across an operation retry. Process restart safely re-uploads through Task 11 idempotency.
- Only one `once` or `run` lifecycle may be active. `once` claims at most one job; `run` sleeps exactly 30,000 ms after an empty claim.
- Heartbeat scheduling starts only after a validated claim and runner construction. It runs every 30,000 ms with position and completed-SKU counts, drains any in-flight call, and stops before pause, evidence, or report submission.
- Login and challenge reports call the Task 3 pause endpoint with fixed messages and do not upload evidence or a completion report.
- Evidence and report operations receive exactly three total attempts for transient failures, with bounded exponential delays of 1,000 ms and 2,000 ms. Authentication, validation, payload-size, and conflict failures are not retried.
- The worker requires the runner report to equal the complete checkpoint report. It removes the checkpoint and clears acknowledged evidence state only after a validated report acknowledgement.
- SIGINT/SIGTERM stops future claims and aborts the active runner. `CollectionRunner` observes cancellation only before work or after a durable phase/SKU save, then throws `CollectionInterruptedError`; no unacknowledged checkpoint is deleted.
- Logs always use the fixed keys `event`, `runId`, `phase`, `discoveredCount`, `skuCount`, and `errorCode`. Tokens, bodies, local paths, evidence bytes, account data, and raw error messages are never logged.

## CLI And Portable Integration

- Added `collector diagnose`, `collector once`, and `collector worker` through package/root scripts.
- `diagnose` verifies Darwin, helper executability, API health contract, pairing without claim, Accessibility trust, Taobao running/front-window/login state, and exact version `2.4.5` build `15`.
- Added `.env.collector.example` while preserving `.env.collector` ignore behavior.
- `pnpm run doctor` invokes live collector diagnostics only on Darwin. Windows/Linux doctor planning returns no collector, Swift, helper, Accessibility, or Taobao action.
- Portable verification now runs the local-environment platform regression.
- Public-audit path policy explicitly permits the required collector example env file while continuing to reject real and environment-specific env files.

## TDD Evidence

Initial focused tests failed with `ERR_MODULE_NOT_FOUND` for each missing agent module. Subsequent RED cases independently demonstrated unsafe localhost preservation, heartbeat leakage on runner-factory failure, missing version/build enforcement, missing SKU-boundary interruption, and rejection of `.env.collector.example` by the public audit. Each focused case passed after its production change.

Final focused agent/CLI coverage includes URL and token validation, timeout/redaction/status mapping, exact routes and payloads, evidence containment/hash/acknowledgement, one-job operation, heartbeat drain, pause behavior, retry counts/delays, non-retryable statuses, report-ack deletion ordering, signal interruption, runner-factory cleanup, command dispatch, and non-macOS early exit.

## Verification

- `pnpm test:collector`: 122 passed, 0 failed.
- `pnpm verify:portable`: local-env 4, config 16, contracts 13, portable API 89, collector 122, and web 10 all passed; collector/API/web typechecks and the production web build passed.
- `node --test scripts/public-audit.test.mjs`: 3 passed, 0 failed.
- Staged-file public audit: 22 files passed with no secret, webhook, or local-user-path finding.
- `git diff --check`: passed.
- Optional full `pnpm audit:public` remains red only for three pre-existing local-path findings in `docs/superpowers/plans/2026-08-21-local-demo-runtime-fixes.md`; no Task 10 file is implicated.
- Swift, Taobao launch, Accessibility access, and live helper execution were not invoked by portable verification.

## Self-Review

- Fixed repository-root resolution for pnpm package working directories.
- Normalized `localhost` to numeric loopback and rejected deceptive/alternate host encodings.
- Moved runner construction before heartbeat startup to prevent timer leakage.
- Drained in-flight heartbeat work before every terminal network operation.
- Added complete checkpoint/report equality before evidence or report upload.
- Opened the realpath-validated evidence target with `O_NOFOLLOW` and sanitized all filesystem errors.
- Verified signal timing before retries and report acknowledgement: cancellation preserves progress, while an already acknowledged report proceeds directly to checkpoint removal.
- Verified only same-hash evidence acknowledgement mutates uploaded state and only report acknowledgement permits checkpoint deletion.

## Concerns

- Task 11 evidence/report endpoints are intentionally not implemented yet; their route and response contracts are covered only by fake fetch until Task 11 lands.
- Task 9 live Accessibility acceptance remains the existing Task 14 gap and was not expanded in this task.
- An independent external review command was not authorized to export the uncommitted diff, so the final race/security review was completed locally with added regressions.
