# Taobao Exact Own Listing Navigation Design

**Date:** 2026-09-07

## Background

A supervised `RME Babyface` pilot proved that the live Taobao search parser can
read 50 positions, but exposed three navigation failures:

- native text replacement followed by Return can leave the old result set in
  place, while pressing the unique verified `搜索` button after the same native
  replacement loads the requested query;
- `openOwnListing` searches the configured URL with a limit of one and opens
  that first result, even when its item ID differs from the configured item;
- live helper snapshots omit nullable properties, while one back-navigation
  selector assumes those properties are always present and can throw an
  unclassified `TypeError`.
- a run checkpoint created after `TAOBAO_NOT_FRONTMOST` skips desktop readiness
  checks on retry and retains the stale readiness issue.

The configured Babyface item is valid and appears under
`星空乐器专营店`, but fresh live searches proved that it can move outside the
first 50 results for the broad model query. Searching with the de-duplicated
model identity plus the configured own-shop name exposed the exact item at
rank 1. The unrelated detail page came from the first-result assumption, not
from a bad catalog record.

## Decision

Keep the existing fail-closed desktop flow and make four focused changes.

1. Live search continues to use the guarded native `replaceText` command, then
   resolves exactly one enabled `AXButton` whose normalized text is `搜索` inside
   the verified `s.taobao.com/search` web area and invokes its `AXPress` action.
   The post-write value check and three-observation result stability gate remain
   mandatory.
2. `CollectionRunner` builds an own-listing query from the configured search
   query, brand, standard model, version, and own-shop name. It normalizes
   whitespace and removes case-insensitive duplicate tokens while preserving
   their first occurrence. `openOwnListing` searches up to 50 positions with
   that scoped query, selects the earliest position whose canonical platform
   item ID equals the configured listing ID, and opens only that position.
   Repeated occurrences of the same configured item are allowed because
   Taobao can repeat a listing across result positions; zero matches fail
   closed.
3. The helper-client snapshot boundary restores omitted nullable accessibility
   properties to `null`, and live navigation selectors also treat absent
   optional strings as missing values. A malformed snapshot must return a
   profiled UI error instead of leaking a JavaScript `TypeError`.
4. Every run attempt, including checkpoint resume, performs the existing
   desktop diagnostic before page access. A successful retry removes only stale
   login, challenge, missing-ID, and frontmost readiness issues before
   continuing; unrelated collection issues remain durable.

No direct URL injection, clipboard use, coordinate click, CAPTCHA handling,
automatic repricing, or Enterprise WeChat send is added.

## Data Flow

`CollectionRunner` passes the scoped own-listing query together with each
configured own-listing URL to the driver. The driver extracts the expected item
ID, performs a normal verified search, identifies the exact matching search
card, opens it, and then preserves the existing page-ID and own-shop binding
checks before SKU enumeration. Competitor search continues to use the original
`job.searchQuery`; competitor ranking and reporting remain unchanged.

## Failure Handling

- A missing or ambiguous live search button is `UI_CONTRACT_CHANGED`.
- A missing exact own item in the first 50 positions is `UI_CONTRACT_CHANGED`
  and yields no own baseline.
- A changed item ID or shop after opening remains `UI_CONTRACT_CHANGED`.
- Login and platform challenges retain their existing paused states.
- A retry cannot access a page until front-window and logged-in state have been
  re-confirmed for that attempt.
- Any failed own baseline prevents low-price alerts and notification delivery.

## Test Strategy

Add failing tests before production changes for:

- live native replacement followed by a fingerprinted search-button press;
- rejection of missing, duplicate, disabled, or non-actionable search buttons;
- selecting an exact own item that is not first in the results;
- selecting the earliest occurrence when the exact own item is repeated;
- rejecting zero exact own-item matches;
- forwarding a normalized, de-duplicated model-and-shop query from
  `CollectionRunner` without changing the competitor query;
- snapshot normalization plus omitted accessibility `title` and `value` fields
  in back-action selection.
- a failed frontmost check followed by a retry that diagnoses again, removes the
  stale frontmost issue, and only then accesses a page.

Run the focused selector, live-driver, runner, and worker suites, then the full
collector suite and type checking. Finally run a three-position real Babyface
pilot and inspect every returned SKU before making any price conclusion.

## Acceptance Criteria

- A live `RME Babyface` search updates both the field and result query.
- The configured own listing is searched with model-and-shop scope and selected
  by exact identity rather than rank.
- No unrelated product can become the own baseline.
- Missing AX strings cannot escape as an unclassified exception.
- Every checkpoint retry revalidates current desktop readiness.
- The three-position pilot either reports complete SKU evidence or stops with a
  specific safe issue and sends no notification.
