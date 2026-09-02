# Task 5 Report: Platform-Neutral Desktop Collector Core

## Status

Completed and committed as `feat: scaffold desktop collector core`.

## Implementation

- Added the private `@stau-price-monitor/collector` workspace package with only test and typecheck scripts; no collector start command was introduced.
- Defined the platform-neutral `TaobaoDesktopDriver` interface, typed terminal errors, the exact SKU availability union, ordered SKU dimensions/options, and raw evidence metadata.
- `DriverSkuView` retains raw list, activity, official estimated-payable, and mandatory-fee text, structured `PromotionEvidence`, shared stock state, capture time, and an optional collector-local evidence path.
- Added iterative deterministic SKU Cartesian enumeration. It retains page order, treats no dimensions as one default selection, ignores disabled options, validates duplicate dimension names and per-dimension labels, and applies no size cap.
- Added a recursive sorted collector test runner that resolves the collector source path from its own script location and exits explicitly when no specs are present.
- Wired collector tests into the standard and portable root test chains, collector typechecking into the root typecheck chain, and added only the collector importer to `pnpm-lock.yaml`.

## Files

- Created `apps/collector/package.json`, `apps/collector/tsconfig.json`, `apps/collector/src/core/desktop-driver.ts`, `apps/collector/src/core/sku-enumerator.ts`, and `apps/collector/src/core/sku-enumerator.spec.ts`.
- Created `scripts/run-collector-tests.mjs`.
- Modified `package.json` and `pnpm-lock.yaml`.

## Type Choices

The brief does not name raw-driver field types. `DriverRawEvidence` uses a recursive JSON-value union so later platform drivers can retain redacted semantic snapshot metadata without accepting executable or opaque runtime values. UI fields that may be absent on a page use `string | null`, while the evidence path remains optional and is explicitly collector-local. Item IDs remain nullable because the downstream workflow must report `MISSING_ITEM_ID` rather than manufacture a stable identity.

## TDD Evidence

### RED

Before implementation, ran:

```sh
node --test apps/collector/src/core/sku-enumerator.spec.ts
```

It failed with `ERR_MODULE_NOT_FOUND` for `apps/collector/src/core/sku-enumerator.ts`.

### GREEN

After implementing the enumerator, ran the portable runner:

```sh
node scripts/run-collector-tests.mjs
```

All 5 tests passed: page-order Cartesian enumeration, empty dimensions, disabled options, duplicate dimension names, and duplicate labels.

## Verification

- `pnpm install --lockfile-only` completed and changed only the collector importer in `pnpm-lock.yaml`.
- `node scripts/run-collector-tests.mjs` passed: 5 tests, 0 failures. Running the same script from `apps/collector` passed the same 5 tests.
- The collector static check passed with the workspace TypeScript compiler and Node typings: exit code 0, no diagnostics.
- Existing config/contracts tests passed: 29/29.
- `git diff --check` passed with exit code 0 and no output.

## Concern

`pnpm test:collector` and `pnpm typecheck` could not complete in this worktree because pnpm attempted to recreate its absent package links and the environment could not resolve `registry.npmjs.org`. The dependency-free collector runner passed; the existing portable API chain also showed three dependency-resolution failures for `@nestjs/common`, `jszip`, and `reflect-metadata` after that package-link attempt. No dependency upgrade or full install was performed.
