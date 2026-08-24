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

## Fix Round 1

This section supersedes the original report statements that terminal upload required a matching `COMPLETE` checkpoint and that heartbeat scheduling waited 30 seconds after the preceding request completed.

### RED

- Focused worker probes failed because transient claim errors escaped `run()`, SIGTERM-equivalent stop could not interrupt the intended retry wait, valid `FAILED` reports without checkpoints raised `MISSING_CHECKPOINT`, and valid `PARTIAL_FAILED` reports with non-`COMPLETE` checkpoints raised `INVALID_REPORT`.
- Fake and streaming response bodies remained unsettled after their 15-second request signal aborted. A test watchdog demonstrated that neither returned the required typed transient `TIMEOUT`.
- Heartbeat probes showed no immediate post-claim heartbeat and exposed completion-relative scheduling rather than fixed monotonic start deadlines.
- Evidence probes accepted a symlinked run directory outside the work root, a final-file symlink whose target remained inside the run, and a same-content regular-file replacement between validation and open.
- The combined RED run had 11 focused failures, each attributable to one of the five review findings.

### GREEN

- Every validated terminal `SUCCEEDED`, `PARTIAL_FAILED`, or `FAILED` report is now submitted. A valid checkpoint contributes its evidence manifest regardless of phase; an absent checkpoint skips evidence. Pause reports still call only the Task 3 pause endpoint. A present checkpoint is removed only after report acknowledgement.
- Response parsing carries the original 15-second signal through JSON consumption and races both fake and real body reads against abort. Abort-driven stalls and rejections produce safe transient `TIMEOUT`; completed malformed JSON remains non-transient `INVALID_RESPONSE`.
- Worker mode catches only transient claim failures, logs fixed safe metadata, waits 30,000 ms, and continues. Non-transient claim failures still escape, `once` still makes at most one claim, and stop interrupts the polling wait.
- Heartbeat starts immediately after a validated claim and runner construction. A monotonic deadline timer starts subsequent non-overlapping heartbeats at 30-second boundaries, independent of request duration, and skips missed ticks without a catch-up burst.
- Evidence validation resolves the physical work root and run directory, requires the run directory beneath the root, rejects final symlinks, opens with `O_NOFOLLOW` where available, and compares the validated device/inode identity with the opened handle before reading and hashing bytes.

### Verification

- Focused API/worker/evidence tests: 41 passed, 0 failed.
- `pnpm test:collector`: 139 passed, 0 failed.
- `pnpm verify:portable`: local-env 4, config 16, contracts 13, portable API 89, collector 139, and web 10 passed; all typechecks and the production web build passed without Swift, Taobao, Accessibility, or helper launch.
- `pnpm typecheck`: passed for API, web, and collector.
- `node --test scripts/public-audit.test.mjs`: 3 passed, 0 failed.
- Changed-file public audit: 7 files passed with no secret, webhook, or local-user-path finding.
- `git diff --check`: passed.

### Self-Review

- Cancellation: stop prevents future claims, aborts an active runner only at its durable boundary, interrupts claim/retry sleeps, drains heartbeat, and leaves unacknowledged checkpoint and upload state intact.
- Retry: evidence and report body timeouts receive exactly three attempts with 1,000 ms and 2,000 ms delays; authentication, validation, payload, and conflict errors remain non-retryable.
- Logging: transient claim and heartbeat failures retain only fixed keys and sanitized error codes. Response errors, file errors, and evidence errors retain no body, token, account value, bytes, or path.
- Acknowledgement ordering: evidence keys mutate uploaded state only after same-hash acknowledgement; checkpoint deletion and uploader-state clearing occur only after validated report acknowledgement.
- Heartbeat: the independent deadline timer cannot overlap an in-flight request, a 15-second first timeout leaves the next start at 30 seconds, delayed callbacks advance to the next future deadline, and stop clears the timer before pause or upload.
- Filesystem: canonical root/run/candidate containment, final-symlink rejection, `O_NOFOLLOW`, opened-handle regular-file checks, identity comparison, PNG signature, size bound, and SHA-256 verification jointly close traversal and check/read replacement paths.

### Remaining Concerns

- Task 11 evidence/report endpoints remain isolated fake-fetch contracts until Task 11 implements the server routes.
- Task 9 live Accessibility behavior remains the Task 14 acceptance gap and was not changed in this fix round.
