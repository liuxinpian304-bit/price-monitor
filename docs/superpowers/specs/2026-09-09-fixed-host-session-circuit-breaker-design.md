# Fixed-Host Collector Session Circuit Breaker Design

**Date:** 2026-09-09

## Background

The production collector is currently built around Taobao Desktop 2.4.5 on
macOS. The worker pauses one run when it sees a login page, but then returns to
its claim loop. The API claim transaction does not reject a new claim when the
same collector agent already owns a non-stale running or paused run. With
multiple models, schedules, or worker processes, one expired Taobao session can
therefore open the login flow repeatedly.

The current Mac will be the only collection host. The second Mac and the
Windows computer will use the web dashboard only. Replacing the mature
accessibility-based SKU collector with a new Chrome collector is outside this
repair because it would rebuild search, first-50 traversal, item identity,
promotion evidence, and all-SKU selection at the same time.

## Decision

Keep Taobao Desktop as the collection surface and add an agent-scoped session
circuit breaker.

1. The collector performs a passive Taobao session observation before asking
   the API for work. The observation must not activate Taobao, press a login
   control, submit credentials, or bring a login page to the foreground.
2. Session observations use four states: `READY`, `LOGIN_REQUIRED`,
   `CHALLENGE_REQUIRED`, and `UNAVAILABLE`. Only `READY` is allowed to claim or
   resume work.
3. The API persists the latest state and transition time on `CollectorAgent`.
   The API, rather than a local process flag, is authoritative so the breaker
   survives collector and API restarts.
4. One collector agent may own at most one active workflow. A non-stale
   `RUNNING`, `PAUSED_LOGIN`, or `PAUSED_CHALLENGE` run blocks every additional
   claim for that agent. A stale `RUNNING` run may still be reclaimed by its
   owner under the existing lease rules.
5. When a mid-run login or challenge is reported, that run keeps its checkpoint
   and becomes paused. Later schedules remain queued or coalesced and never
   touch Taobao while the agent session is blocked.
6. When a passive observation changes back to `READY`, the API atomically
   resumes the oldest paused run owned by that agent before considering a new
   queued run. The existing checkpoint prevents completed pages and SKUs from
   being selected twice.
7. A blocked transition creates one durable operational incident. The existing
   approved Enterprise WeChat webhook sends one sanitized alert for that
   incident. Repeated blocked observations do not create or send another alert.
   Recovery is recorded and collection resumes silently.
8. The operations UI shows the collector session state, last observation time,
   and the blocked run when present. It does not offer automatic credential
   entry or challenge bypass.

## Fixed-Host Operation

- Only the current Mac keeps the collector pairing token and runs
  `collector:worker`.
- Taobao Desktop remains installed, open, and signed into the dedicated
  monitoring account on this Mac.
- The same monitoring account is not used for collection on the other Mac or
  Windows computer.
- Dashboard and API access remain cross-platform; they do not require a Taobao
  login.

## Data Model

`CollectorAgent` gains the latest observed session state, the observation time,
and the transition time. A `CollectorSessionIncident` record stores one blocked
episode, its sanitized reason, recovery time, and durable WeChat delivery
state. Only one unresolved incident may exist for an agent.

No cookies, passwords, QR payloads, authorization headers, or raw login-page
content are stored. Evidence remains limited to the existing sanitized
collector diagnostics and price screenshots.

## Data Flow

Before every claim, the macOS collector snapshots the Taobao application window
without activating it and classifies the session. It sends that observation in
the authenticated claim request.

The API serializes claims for the collector agent. A blocked observation updates
the agent state, opens or reuses one incident, and returns no job. A ready
observation closes an active incident and resumes the oldest owned paused run;
otherwise it applies the existing stale-lease and queued-run ordering.

If the session expires after a job starts, the runner returns `PAUSED_LOGIN` or
`PAUSED_CHALLENGE` as it does today. The pause transaction updates both the run
and the agent state, so a second worker or a restarted process cannot claim the
next model.

## Failure Handling

- `UNAVAILABLE` is fail-closed: no work is claimed and no login conclusion is
  made.
- Conflicting or malformed session observations are rejected before a claim.
- An API/database failure leaves the collector idle; it never falls back to
  local permission to scrape.
- Enterprise WeChat delivery follows the existing bounded-attempt and ambiguous
  result rules. Notification failure does not reopen collection.
- A challenge always requires the operator to complete the platform-provided
  flow. The collector never bypasses CAPTCHA or risk controls.

## Test Strategy

Add failing tests first for:

- passive session classification without an `activate` command;
- no claim while the observed session is blocked or unavailable;
- one active or paused workflow per collector agent under concurrent claims;
- exactly one incident across repeated blocked observations;
- automatic paused-run recovery after the first ready observation;
- checkpoint preservation across pause and automatic recovery;
- one sanitized Enterprise WeChat alert per blocked episode;
- operations UI rendering for ready, blocked, and unavailable states.

Run focused collector, API, and web tests first. Then run collector type checking,
API type checking, the full collector suite, the portable API unit suite, web
tests, and `git diff --check`. Database integration tests must use an isolated
test schema before they are allowed to run against this worktree.

## Acceptance Criteria

- An expired Taobao session can surface at most one login-required incident,
  regardless of the number of models, schedules, or collector worker processes.
- No later model opens or interacts with Taobao while the circuit is blocked.
- Restarts preserve the blocked state.
- After one successful manual Taobao login, the next passive observation resumes
  the paused run automatically and continues the queue from its checkpoint.
- The operations group receives no more than one sanitized WeChat alert for one
  blocked episode.
- The current Mac is the only enabled collection host; the other computers can
  continue to use the dashboard without Taobao credentials.
- No login, CAPTCHA, cookie extraction, credential storage, or automatic price
  modification is introduced.
