# Taobao Semantic Search Submit Design

**Date:** 2026-08-31

## Background

The macOS Taobao collector can locate the desktop app search field and replace
its value. In the current Taobao Desktop runtime, sending Return immediately
after `AXUIElementSetAttributeValue` does not submit the search because setting
an accessibility value does not guarantee keyboard focus. The field changes,
but the result page remains on the previous query and the collector eventually
fails its transition timeout.

A fresh runtime accessibility snapshot shows one enabled `AXButton` titled
`搜索` in the Taobao search web area. The button exposes `AXPress`, which is the
semantic accessibility action for submitting the search.

## Decision

Submit live Taobao searches through the semantic `AXPress` action on the unique
search button after setting and verifying the query value. Do not use a
keyboard Return event for live search submission.

The synthetic test profile may continue to submit through the search field's
semantic `AXConfirm` action. Both profiles therefore use accessibility actions,
while the live profile matches the control exposed by the installed Taobao
Desktop version.

## Selector Contract

The live selector must resolve a submit action only when all of the following
conditions hold:

1. The supported Taobao search web area is uniquely identified and its URL is
   under `s.taobao.com/search`.
2. Exactly one descendant has role `AXButton` and normalized visible text
   exactly equal to `搜索`.
3. The button is enabled.
4. The button exposes the `AXPress` action.

Missing, duplicate, disabled, or non-actionable candidates are treated as a UI
contract change. The collector must stop safely instead of clicking an
ambiguous control.

For the synthetic profile, the existing uniquely selected search field must be
enabled and expose `AXConfirm`. Missing or duplicate semantic submit actions
also fail closed.

## Search Flow

1. Take the initial snapshot and run the existing login, challenge, and UI
   stop-state checks.
2. Resolve the unique search field and capture the existing pre-submit result
   signature.
3. Set the search field value to the requested query.
4. Take a fresh snapshot and repeat the stop-state checks.
5. Re-resolve the search field and verify that its normalized value exactly
   matches the requested query.
6. Resolve the profile-specific semantic submit action:
   - live profile: `AXPress` on the unique `搜索` button;
   - synthetic profile: `AXConfirm` on the unique search field.
7. Perform the action against the exact selected element path and fingerprint.
8. Continue through the existing stable-search transition wait. All rank,
   result, SKU, login, challenge, and UI drift safeguards remain unchanged.

If the post-write value cannot be verified, the submit control cannot be
resolved uniquely, the action fails, or the result page does not transition,
the run fails safely with no notification or price-changing side effect.

## Code Scope

Expected changes are limited to:

- macOS Taobao selector helpers for the live and synthetic profiles;
- the Taobao macOS driver search-submit flow;
- focused selector and driver tests;
- test fixtures required to represent the real live search button.

There are no API, database schema, report format, scheduling, enterprise WeChat,
or repricing changes in this work.

## Test Strategy

Implementation follows test-driven development.

1. Add a failing live-driver test that requires this order: set query, take a
   fresh snapshot, perform `AXPress` on the semantic search button, then wait
   for stable results. It must also assert that Return key code `36` is not sent.
2. Add live-selector tests for the valid button and for missing, duplicate,
   disabled, and non-`AXPress` candidates.
3. Preserve or add synthetic-selector coverage for field `AXConfirm`.
4. Run the focused search-submit tests, the complete collector suite, collector
   type checking, and the repository diff check.
5. After all automated checks pass, run collector diagnosis against the real
   Taobao Desktop app.
6. Only then create one replacement three-position RME Babyface Pro FS pilot
   run. The pilot must remain notification-disabled and must never change a
   price.

## Acceptance Criteria

- Entering a new query causes the live Taobao result page to transition and
  stabilize without relying on keyboard focus.
- A live search is submitted only through one enabled exact-title `搜索` button
  that exposes `AXPress`.
- Ambiguous or changed UI fails closed.
- Existing login, challenge, rank, SKU, and UI-contract safeguards continue to
  pass their regression tests.
- The replacement three-position pilot can reach product collection without
  sending enterprise WeChat notifications or modifying prices.
