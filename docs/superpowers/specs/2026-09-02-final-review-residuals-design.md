# Final Review Residuals Design

## Scope

Resolve the three remaining Important findings from the collector branch review without expanding product behavior:

1. Accept Chinese text directly adjacent to a Latin or numeric model code while still rejecting model continuations such as `MDR-7506A` and `XMDR-7506`.
2. Quarantine a run when the worker's post-run checkpoint reload fails with the deterministic `INVALID_CHECKPOINT` code, while continuing to requeue transient or unknown checkpoint-load failures.
3. Keep the two Prisma desktop-report integration fixtures compatible with the exact capability contract required by `taobao-desktop` claims.

No live Taobao collection, API lifecycle operation, database execution, Redis queue operation, Enterprise WeChat notification, or repricing action is part of this change.

## Considered Approaches

### 1. Targeted boundary and error classification (recommended)

Keep the current matcher and worker structure. Add a model-aware boundary rule, branch the second checkpoint-load error path on the existing stable error code, and update only the stale fixtures. This has the smallest behavioral surface and preserves the existing fail-closed controls.

### 2. Replace matching with a tokenizer and typed model grammar

This could make future model rules more expressive, but it would alter every model and alias match and would require a much wider regression matrix. It is disproportionate to the three review findings.

### 3. Restore unbounded substring matching and always quarantine load failures

This is the shortest patch, but it would reintroduce false matches such as `MDR-7506A` and could permanently fail runs for temporary filesystem errors. It is rejected.

## Matcher Design

`containsBoundedModelPhrase` continues to normalize punctuation and spacing. For phrases containing a Latin-script character or number, Han characters are accepted as separators at either edge of the phrase. Other letters and all numbers remain continuation characters, so Latin-prefix, Latin-suffix, and numeric-suffix variants do not match.

Pure-Han phrases retain the current strict Unicode letter/number boundary behavior. This prevents the fix from turning Chinese aliases into arbitrary substring matches.

Tests cover Chinese directly before and after `MDR-7506`, plus the existing punctuation and spacing behavior. Separate negative tests cover `XMDR-7506`, `MDR-7506A`, and `MDR-75060`.

## Checkpoint Design

The worker classifies an exception from the post-run `checkpointStore.load` call using the same sanitized stable-code helper already used for runner failures:

- `INVALID_CHECKPOINT`: release with `QUARANTINE` and surface `CHECKPOINT_FAILED`.
- Any other error: ordinary release/requeue and surface `CHECKPOINT_FAILED`.

Neither path removes the checkpoint nor clears evidence. Tests assert the release disposition and retained evidence for both deterministic and unknown load errors.

## Integration Fixture Design

The two desktop-report integration claims advertise exactly:

```ts
["accessibility", "all-sku", "png-evidence"]
```

This aligns the fixtures with the production provider profile. The database-backed tests are not executed in this cycle because database access is outside the authorized boundary; TypeScript compilation and portable tests provide the available static and regression coverage.

## Verification

Run focused matcher and worker tests first, then the portable test suite, TypeScript/web build, `git diff --check`, and a clean-worktree check. An independent reviewer examines only the commits created for this scoped cycle before completion is claimed.
