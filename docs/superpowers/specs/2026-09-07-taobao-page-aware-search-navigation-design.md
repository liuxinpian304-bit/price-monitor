# Taobao Page-Aware Search Navigation Design

**Date:** 2026-09-07

## Background

The supervised `RME Babyface` pilot now submits and stabilizes the requested
search correctly. The first result page exposes about 40 product cards, while
the configured own-listing lookup requests the first 50 positions. Taobao
Desktop exposes explicit pagination for this result set (`1/8` plus verified
previous and next buttons), but the collector currently falls back to Page
Down. That leaves the semantic result signature unchanged and fails after the
15-second stability deadline.

The same mismatch also affects position replay. After collecting page two,
the driver uses Home to reconstruct page one. Home changes scroll position but
does not change Taobao's page number, so an exact ranked result cannot be
reliably reopened.

## Decision

Keep the existing fail-closed accessibility contract and add page-aware live
navigation.

1. Inside the verified `s.taobao.com/search` web area, recognize exactly one
   pagination group with DOM class `next-pagination-pages` when it is present.
   Parse one current-page button whose description is exactly
   `第N页，共M页`, and cross-check it against the `next-pagination-display`
   values `N`, `/`, and `M`.
2. Resolve the previous and next controls only from direct children of that
   pagination group. They must be `AXButton` nodes with `AXPress`, the required
   `next-pagination-item` class, the corresponding `next-prev` or `next-next`
   class, and a description whose current page equals the parsed state.
3. Prefer the verified next-page `AXPress` action over `AXScrollDown` and Page
   Down. Treat `currentPage === totalPages` as a verified end state. If no
   strict pagination group exists, preserve the existing scroll and Page Down
   behavior for the already-approved infinite-scroll profile.
4. Include pagination state in the stable search signature. When the page
   number changes, append the whole new page in DOM rank order; do not apply
   viewport overlap removal across page boundaries.
5. Before replaying a stored rank, return to page one with the verified
   previous-page action until the original top-page signature is restored.
   Then advance page by page, rebuild the global rank, and retain the existing
   complete card-evidence equality check before opening anything.
6. Bound both rewind and forward traversal to 50 actions. Any malformed,
   ambiguous, disabled, stale, non-progressing, or contradictory pagination
   state remains `UI_CONTRACT_CHANGED` and causes no price conclusion.

No coordinate clicks, URL injection, CAPTCHA handling, automatic repricing,
or Enterprise WeChat delivery is added. The previously observed stale item
detail drawer is not changed in this patch because it has not yet been proven
to cause the current search timeout; it will be investigated separately only
if the page-aware pilot reaches and then fails detail collection.

## Data Flow

`search(query, limit)` reads a stable first page, records its signature, and
uses the strict next-page action until it has the requested positions or
reaches the verified final page. Search positions remain compatible with the
existing API and checkpoint schema.

`openSearchPosition(position)` reads the current page. If it is not the saved
first-page context, the driver traverses verified previous controls until that
context is restored. It then rebuilds ranks with the same page-aware merge
rules, verifies every field of the requested card, and presses only its raw AX
node with a fresh fingerprint.

## Test Strategy

Add failing tests first for:

- parsing one strict live pagination state and rejecting contradictory state;
- preferring the verified next-page button and recognizing the final page;
- preserving every duplicate occurrence across a true page boundary;
- returning from page two to page one with the verified previous button;
- reopening a rank on page two after deterministic replay;
- retaining AX scroll and Page Down fallback when pagination is absent;
- rejecting disabled, ambiguous, or non-progressing pagination controls.

Run the focused live selector and driver tests, the complete collector suite,
collector type checking, and `git diff --check`. Then activate the logged-in
Taobao Desktop app and rerun the real three-position `RME Babyface` pilot.

## Acceptance Criteria

- A 50-position Babyface lookup advances from page one through the exact
  verified pagination action instead of Page Down.
- Page boundaries do not remove legitimate duplicate ranks.
- Stored ranks can be reopened from either page one or page two without a
  coordinate click or direct URL navigation.
- Any pagination contract drift fails before a product link is pressed.
- The real pilot either produces own and competitor SKU evidence or stops with
  a new, specific, evidence-backed issue.
