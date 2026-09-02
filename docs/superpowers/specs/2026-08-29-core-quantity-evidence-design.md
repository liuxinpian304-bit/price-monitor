# Core Quantity Evidence Repair Design

## Context

The collector derives structured SKU components from the selected Taobao SKU labels when the desktop driver cannot provide an explicit component list. The current parser strips a trailing quantity from package tokens, but the single-product aliases `单麦克风`, `单机`, `单品`, and `裸机` then bypass quantity assignment. As a result, `单机2件` is emitted as one core product with no `UNKNOWN` evidence.

The API includes core quantity in `sku-combination-v1`. Losing the explicit quantity can therefore collapse different combinations into one signature and permit a false low-price alert.

## Approved Scope

Repair only component quantity evidence in `apps/collector/src/core/sku-component-evidence.ts` and its focused tests. Do not change API signatures, comparison thresholds, report behavior, live-send controls, or unrelated parsing rules.

The user approved this focused repair on 2026-08-29 by replying `继续修复` after the defect and proposed red-test/minimal-fix/full-verification flow were presented.

## Approaches Considered

1. **Track explicit quantity evidence and assign it conflict-safely (recommended).**
   - Preserve whether a token actually contained a trailing quantity.
   - Apply explicit quantities from the standard model and recognized single-product aliases to the core component.
   - Emit `UNKNOWN` when two explicit core quantities conflict.
   - This preserves valid evidence while failing closed on ambiguity.

2. **Mark every single-product alias with a quantity as unknown.**
   - Safest mechanically, but discards clear evidence such as `单机2件` and sends valid combinations to review unnecessarily.

3. **Move all quantity inference into the API combination builder.**
   - Centralizes policy but duplicates parsing inputs across contracts and expands the change far beyond this defect.

Approach 1 is selected because it is the smallest change that preserves exact-combination behavior.

## Detailed Behavior

- `单机`, `裸机`, `单品`, and `单麦克风` without a written quantity keep the default core quantity of `1`.
- `单机2件`, `裸机2件`, `单品3个`, and equivalent unambiguous positive integer forms set the core quantity to the written value.
- Standard-model evidence such as `NT1S2件` follows the same rule.
- Repeated explicit evidence with the same quantity is accepted.
- Conflicting explicit evidence such as `NT1S2件/单机3件` or `NT1S2件/单机1件` adds an `UNKNOWN` component. Downstream combination building then returns `REVIEW` and cannot emit an exact-price alert.
- Implicit labels such as `NT1S2件/单机` do not contradict the explicit quantity because the bare alias contains no quantity evidence.
- Malformed, signed, fractional, and multi-valued quantities keep the existing fail-closed behavior.

## Implementation Boundary

Extend the internal valid result of `componentTokenQuantity` with a boolean that records whether quantity evidence was explicit. Reuse one conflict-safe core assignment helper for recognized core tokens. No public type or persisted schema changes are needed.

## Verification

1. Add focused tests that fail against the current parser for recognized aliases and conflicting evidence.
2. Run the focused test file and record the expected red failures.
3. Implement the minimal parser change and rerun the focused tests.
4. Run all collector tests, `pnpm verify`, `pnpm audit:public`, and `git diff --check`.
5. Run an independent scoped code review of the repair diff.

## Success Criteria

- Explicit core quantities survive collection.
- Conflicting core quantities always force review.
- Existing single-product, paid-accessory, material-attribute, malformed-quantity, and deduplication tests remain green.
- No live Taobao collection or Enterprise WeChat delivery is triggered by this repair.
