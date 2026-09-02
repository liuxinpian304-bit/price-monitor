# Taobao Native Search Input Design

**Date:** 2026-09-01

## Background

The macOS Taobao collector must submit both configured own-listing URLs and
model search queries through Taobao Desktop 2.4.5 build 15. The previous live
flow wrote the accessibility value and pressed the unique `搜索` button with
`AXPress`. A supervised three-position pilot stopped safely before collecting
the own baseline because the result page did not transition.

Read-only runtime inspection and controlled manual probes established the
failure boundary:

- `AXUIElementSetAttributeValue` changed the visible search-field value but did
  not update the search page URL or result query.
- `AXPress` on the enabled exact-title `搜索` button returned success from the
  accessibility API but did not transition the page.
- Focusing the field through `AXPress` and sending Return also did not
  transition the page.
- Precisely selecting the existing field text, entering the replacement through
  real text-input events, and sending Return changed the result page from
  `RME Babyface` to `RME Babyface Pro FS` and loaded a new result set.

The root cause is therefore not login state, a platform challenge, or result
recognition. Taobao's web search input requires real edit events; setting only
the accessibility value does not update the web application's internal state.

## Decision

Add two narrowly scoped native helper commands named `activate` and
`replaceText`. For the live Taobao profile, the collector will first activate
the supported application, take a fresh snapshot, and then use `replaceText` to
replace the search query through real text-input events. It will verify the
resulting accessibility value from another fresh snapshot and submit with the
existing allowlisted Return key event.

The helper will not use the system clipboard. The live collector will no longer
use `AXPress` on the `搜索` button as its submit mechanism. The synthetic test
profile may retain its existing `setValue` plus `AXConfirm` behavior because it
does not represent a live web input.

## Native Helper Contract

`activate` accepts only the existing command envelope. It activates the
supported Taobao process and waits for at most two seconds for that exact
process to become frontmost. It returns only a boolean completion marker and
fails without sending input when activation cannot be confirmed.

`replaceText` accepts the existing command envelope plus:

- `nodePath`: the exact path selected from a fresh snapshot;
- `fingerprint`: the selected node fingerprint;
- `value`: the non-empty replacement text.

The helper must fail closed unless all of these conditions hold:

1. The target application is the supported `com.taobao.pcdesktop` process and
   is still frontmost immediately before text events are posted.
2. The resolved element still matches the supplied path and fingerprint.
3. The element role is `AXTextField`, it is enabled and editable, and its
   accessibility description is exactly `请输入搜索文字`.
4. The replacement is non-empty after normalization and no longer than 2,048
   UTF-16 code units.
5. The field can be focused and its complete current text can be selected.
6. Native Unicode text events can be posted to the Taobao process.

The command returns only a boolean completion marker. It must not echo the
query, URL, credentials, clipboard contents, or other field data in protocol
responses or diagnostic output.

## Live Search Flow

1. Run the existing app-version, login, challenge, and front-window checks.
2. Call `activate`, require frontmost confirmation, and take a fresh snapshot.
3. Resolve the unique live search field and capture the
   pre-submit result signature.
4. Call `replaceText` with the exact field path, fingerprint, and requested
   query.
5. Take another fresh snapshot, repeat all stop-state checks, re-resolve the
   field, and verify its normalized value exactly equals the requested query.
6. Send the existing allowlisted Return key code `36` while Taobao remains
   frontmost.
7. Reuse the current stable-result guard: the field value, URL result query,
   and result signature must represent the requested query for three
   consecutive observations.
8. Continue into rank, item, and SKU collection only after that stability gate
   passes.

For the synthetic profile, retain the current semantic fixture flow:
`setValue`, fresh value verification, then `AXConfirm` on the profiled field.

## Failure Handling

The helper must return a specific safe error for an invalid target, stale path,
wrong role or description, non-frontmost app, selection failure, or text-event
failure. The TypeScript client maps helper errors through the existing driver
error boundary.

A replacement-value mismatch or a result transition timeout remains
`UI_CONTRACT_CHANGED`. Existing login and platform-challenge errors keep their
current paused states. No fallback may silently use clipboard paste, coordinate
typing, URL injection, browser automation, or an unverified button action.

Any failure before a complete authoritative own baseline prevents comparison.
Failed or empty runs must not produce low-price conclusions, confirm an
Enterprise WeChat notification, or perform a price-changing action.

## Code Scope

Expected implementation changes are limited to:

- the Swift helper protocol and native accessibility application;
- a small native text-event abstraction that can be unit tested without posting
  real events;
- the TypeScript helper command type;
- the live branch of the macOS Taobao search driver;
- focused Swift and TypeScript tests;
- removal of the now-invalid live `AXPress` submit selector and expectations.

There are no API, database, scheduling, report-shape, Enterprise WeChat, or
repricing changes.

## Test Strategy

Implementation follows test-driven development.

1. Swift protocol tests cover valid and malformed `activate` and `replaceText`
   requests.
2. Native helper tests prove bounded activation, exact target validation,
   frontmost enforcement,
   full-text selection, Unicode event posting, length limits, and redacted
   responses. Event posting is injected behind a test double.
3. Live TypeScript driver tests require this order: `activate`, snapshot,
   `replaceText`, fresh verified snapshot, Return, then stable-result
   observations. They also assert that live search does not call `setValue` or
   button `AXPress`.
4. Synthetic tests continue to require `setValue` and `AXConfirm`.
5. Existing mismatch, login, challenge, rank, duplicate, sponsored result,
   identity, SKU, and transition-timeout tests remain green.
6. Run the complete Swift helper suite, focused collector tests, full collector
   suite, collector type checking, and repository diff checks.
7. Perform a controlled live search for `RME Babyface Pro FS` and verify that
   field value, URL query, and results transition. This is not a collection run.
8. Do not create another collection run until the user separately authorizes a
   new supervised pilot.

## Acceptance Criteria

- A live own-listing URL and a normal model query both update Taobao's actual
  result URL and load a new result set.
- Live replacement uses real Unicode input events without reading or modifying
  the clipboard.
- The native helper activates only the supported Taobao process and can affect
  only the exact enabled Taobao search field while that process is frontmost.
- The collector verifies the written value before Return and verifies three
  stable result observations afterward.
- Live search performs no `AXPress` on the `搜索` button.
- Any focus, selection, input, UI-contract, login, or challenge failure stops
  safely with no notification confirmation and no price change.

## Operational Note

Each scheduled check may bring Taobao Desktop to the foreground for roughly one
to two seconds while replacing and submitting a query. The user explicitly
approved this behavior. The collector must never send text events to another
application or continue when Taobao is not confirmed frontmost.
