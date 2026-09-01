# Taobao Search Shop-Link Fallback Design

**Date:** 2026-09-01

## Context

The live Taobao Desktop search page still exposes supported product links,
titles, and one unambiguous display price per visible product card. It no longer
labels the shop-name node with the accessibility descriptions previously used
by the collector (`店铺` or `店铺名称`). The existing fail-closed parser therefore
rejects every visible card even though each card exposes exactly one pressable,
text-bearing link whose URL has shop, store, or seller semantics.

Sanitized live diagnostics established the following current-page shape:

- 47 supported product links and 47 readable titles;
- 47 cards with a single-price ancestor;
- no card with the old shop accessibility descriptions; and
- exactly one pressable, text-bearing, shop-like URL link in every single-price
  card scope.

No product title, shop name, URL, price, query text, or raw accessibility tree
was printed or persisted by those diagnostics.

## Goal

Restore strict, read-only parsing of live Taobao Desktop search cards when the
shop name is represented by a unique shop link instead of an explicit shop
accessibility description.

## Non-Goals

- Do not loosen display-price parsing.
- Do not infer a shop name from arbitrary residual text.
- Do not open product detail pages to discover shop names.
- Do not skip structurally ambiguous cards and silently return partial data.
- Do not start a collection run or any API job lifecycle.
- Do not write checkpoints, database records, or other persistent state.
- Do not send Enterprise WeChat messages or trigger repricing.

## Selected Approach

Keep explicit semantic shop labels as the primary source. Add one strict
fallback inside the existing card-evidence boundary:

1. Collect distinct non-empty shop names from nodes whose accessibility
   description is an accepted explicit shop label.
2. If exactly one explicit shop name exists, use it and do not consult the
   fallback.
3. If no explicit shop name exists, collect candidate links within the same
   candidate card scope that:
   - have role `AXLink`;
   - support `AXPress`;
   - expose non-empty text;
   - expose a URL; and
   - have verified shop, store, or seller URL semantics.
4. Accept the fallback only when it yields exactly one distinct shop name.
5. Reject the card scope when either source is ambiguous or when neither source
   yields a shop name.

The parser continues to require exactly one distinct display-price text and one
resolved shop name in a candidate scope. The existing deepest-valid-ancestor
selection, duplicate-scope checks, rank ordering, sponsored detection, and
fail-closed error behavior remain unchanged.

## URL Classification

Shop-link classification must use a focused helper rather than a free-form
substring test spread through the parser. The helper accepts only valid HTTP or
HTTPS URLs whose normalized host or path/query structure has known shop, store,
or seller semantics. Product-detail URLs remain product links and cannot qualify
as shop links merely because unrelated text contains one of those words.

Malformed URLs and unsupported schemes are not candidates. Tests define the
accepted and rejected URL shapes before the production helper is added.

## Error Handling

The implementation remains fail closed:

- one explicit shop name: accept it;
- multiple explicit shop names: reject the scope;
- no explicit name and one valid shop-link name: accept the fallback;
- no explicit name and zero or multiple fallback names: reject the scope;
- one price is still required independently of shop resolution.

An ambiguous link must never be chosen by order, position, or longest text.

## Testing

Use test-driven development for the selector change.

Automated coverage must include:

- the existing explicit-description fixture still parses unchanged;
- a live-style card with no explicit description and one valid shop link parses;
- zero valid shop links fails closed;
- multiple distinct valid shop links fail closed;
- malformed, unsupported, and product-detail URLs are rejected as fallbacks;
- an explicit shop description takes precedence over fallback candidates;
- price ambiguity continues to fail closed; and
- the full collector test suite and TypeScript typecheck pass.

After automated verification, run only the two previously approved,
non-persistent `driver.search()` probes:

1. `https://detail.tmall.com/item.htm?id=550902914950`
2. `RME Babyface Pro FS`

Live reporting remains sanitized: counts, termination reasons, booleans, and
supported-link counts only. Do not display or persist product titles, shop
names, URLs, prices, queries, raw accessibility data, credentials, or
environment values.

## Success Criteria

- Current live search cards stabilize without weakening price or ambiguity
  checks.
- Both approved read-only probes complete or produce a precise sanitized stop
  reason unrelated to missing legacy shop descriptions.
- No write, notification, repricing, or collection-run side effect occurs.
