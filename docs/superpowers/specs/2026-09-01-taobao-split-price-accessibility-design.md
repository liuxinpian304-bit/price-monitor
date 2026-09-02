# Taobao Split-Price Accessibility Design

**Date:** 2026-09-01

## Context

The current Taobao Desktop search state is healthy and matches the second
approved query. Sanitized diagnostics found 42 supported item links and 42
strict shop links. Forty-one cards satisfy the existing one-price/one-shop
contract. One non-sponsored, uniquely identified card has a resolved shop but
exposes two bare integer accessibility texts in the price region.

Aggregate geometry established a strict split-price shape for that card:

- one currency-symbol node appears before both numeric nodes;
- one numeric text is the longer major component and one is a one-digit tail;
- both are `AXStaticText` nodes on the same visual line;
- the tail is positioned after the major component;
- the major component's frame contains the tail's frame; and
- the tail is centered in the rightmost quarter of the major component's frame.

No product title, shop name, URL, price value, query value, raw accessibility
tree, credential, or environment value was printed or persisted.

## Goal

Parse a price whose major and fractional components are exposed as separate
accessibility nodes, while preserving fail-closed behavior for every other
multi-price shape.

## Non-Goals

- Do not choose one value from two independent prices.
- Do not skip a card with unresolved or ambiguous price evidence.
- Do not infer price from title text alone.
- Do not change shop resolution, card-scope isolation, rank ordering,
  duplicate handling, sponsored detection, or search stability behavior.
- Do not start a collection run or any API job lifecycle.
- Do not write checkpoints, queue state, database records, or other persistent
  state.
- Do not send Enterprise WeChat messages, notifications, or repricing actions.

## Selected Approach

Keep the existing single-text `priceRange` path authoritative. Add one strict
node-aware fallback used only when a candidate card has exactly two distinct
numeric price texts.

The fallback accepts a split price only when all of these conditions hold:

1. Both distinct numeric texts each map to exactly one enabled accessibility
   node in the candidate evidence set.
2. Both nodes have role `AXStaticText` and expose non-null position and size.
3. One text is a positive whole-number major component of 2 through 8 digits.
4. The other text is a fractional tail of 1 or 2 digits and numerically less
   than 100.
5. The major text is longer than the fractional text.
6. The fractional node is visually after the major node and their vertical
   positions differ by no more than 20 points.
7. The major node's frame fully contains the fractional node's frame.
8. The fractional node's center lies in the rightmost quarter of the major
   node's frame.
9. Exactly one `¥` or `￥` accessibility node exists in the same evidence set,
   has position data, appears to the left of the major node, and lies within 20
   vertical points and 120 horizontal points of it.

If every condition holds, normalize a one-digit fractional tail by appending a
zero (`5` becomes `50`) and produce one fixed two-decimal price. The resulting
minimum and maximum display prices are identical.

Any absent geometry, duplicate text node, unsupported role, missing or multiple
currency symbol, reversed layout, non-contained tail, non-rightmost tail,
unsupported digit count, or third numeric text keeps the card unresolved. The
parser must not fall back to ordering, numeric magnitude, or the first value.

## Components

### Price Candidate Extraction

Collect candidate nodes rather than immediately collapsing them to strings.
Group them by normalized numeric text so duplicate accessibility exposure can
be detected. The existing one-distinct-text path continues to call
`priceRange` unchanged.

### Split-Price Resolution

A focused helper receives the evidence nodes and returns a normalized
`[minimum, maximum]` pair or `null`. It owns all split-price validation and has
no knowledge of shops, search rank, or card traversal.

### Card Evidence

`cardEvidence` asks the focused price helper for one resolved display price and
continues to require one resolved shop name. Its ancestor traversal and
recursive sibling-item evidence isolation remain unchanged.

## Error Handling

The behavior remains fail closed:

- one normal distinct price text: use existing parsing;
- exact verified split-price shape: combine it;
- any other zero, duplicate-node, two-price, or multi-price shape: reject the
  candidate scope;
- no candidate scope with one resolved price and shop: raise the existing UI
  contract error.

No partial card list is returned when a supported item remains ambiguous.

## Testing

Use test-driven development. Automated coverage must include:

- the existing normal single-price and price-range fixtures remain unchanged;
- one strict one-digit fractional tail normalizes to two decimals;
- a two-digit fractional tail remains two digits;
- missing or multiple currency symbols fail closed;
- absent position or size fails closed;
- wrong node roles fail closed;
- reversed, vertically separated, non-contained, and non-rightmost layouts fail
  closed;
- major/fraction digit limits fail closed;
- duplicate nodes for either numeric text fail closed;
- a third numeric text fails closed; and
- all existing shop-fallback, nested-card, duplicate-scope, collector-suite,
  and typecheck checks pass.

After automated verification, run a read-only snapshot check first. It must
parse all currently supported links without printing card content. Then run
three diagnoses and one bounded two-search probe using only the two previously
approved values. If the command yields a session identifier, poll that same
session to completion instead of launching another probe.

Live output remains limited to counts, termination reasons, booleans, and
supported-link counts. Stop after any live-command failure and do not retry
outside the driver's bounded observation loop.

## Success Criteria

- The current read-only state parses all 42 supported item links.
- Existing normal price behavior remains unchanged.
- Unsupported two-price layouts still fail closed.
- Every automated test and typecheck passes.
- Three diagnoses pass.
- Both approved searches return one position with `LIMIT_REACHED`, or a single
  precise sanitized stop reason is recorded without retry.
- No lifecycle, persistence, notification, repricing, or collection-run side
  effect occurs.
