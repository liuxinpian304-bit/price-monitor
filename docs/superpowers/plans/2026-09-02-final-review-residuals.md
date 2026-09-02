# Final Review Residual Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the three remaining Important review findings without widening the collector's live or persistence behavior.

**Architecture:** Preserve the existing matcher, worker, and provider-profile boundaries. Make the matcher boundary sensitive to Latin/numeric model codes, classify the worker's post-run checkpoint reload through the existing stable error code, and align two database integration fixtures with the production capability contract.

**Tech Stack:** TypeScript, Node.js test runner, pnpm workspace, Prisma integration fixtures.

## Global Constraints

- Do not run live Taobao collection or search.
- Do not call the collector API lifecycle, database, Redis queue, Enterprise WeChat, notifications, or repricing paths.
- Report only sanitized status; never expose product titles, shops, URLs, prices, queries, raw accessibility trees, credentials, or environment values.
- Preserve strict rejection of Latin or numeric model continuations.
- Quarantine only errors whose sanitized stable code is exactly `INVALID_CHECKPOINT`.
- Do not remove checkpoints or clear evidence on either checkpoint-load failure path.
- Database integration tests remain unexecuted in this cycle; validate their fixture edits statically and through compilation.

---

### Task 1: Model Boundaries Beside Chinese Text

**Files:**
- Modify: `apps/api/src/matching/matcher.service.spec.ts`
- Modify: `apps/api/src/matching/matcher.service.ts`

**Interfaces:**
- Consumes: `MatcherService.match(rule: MonitoredProductRule, offer: RawOffer): MatchDecision`
- Produces: Existing `containsBoundedModelPhrase(haystack: string, phrase: string): boolean` behavior with Han separators for Latin/numeric model phrases only.

- [ ] **Step 1: Write failing Chinese-adjacency and continuation tests**

Add tests that remove aliases from the Sony rule so the standard model match is the only success path:

```ts
const strictSonyRule = { ...sonyRule, effectiveAliases: [] };

test("accepts a Latin model directly beside Chinese product text", () => {
  const candidate = sonyOffer("监听耳机MDR-7506单机");
  candidate.title = "索尼专业监听耳机";

  const decision = new MatcherService().match(strictSonyRule, candidate);

  assert.equal(decision.category, "BARE");
  assert.equal(decision.comparable, true);
});

for (const continuation of ["XMDR-7506", "MDR-7506A", "MDR-75060"]) {
  test(`rejects model continuation ${continuation}`, () => {
    const candidate = sonyOffer(`${continuation} 单机`);
    candidate.title = "索尼专业监听耳机";

    const decision = new MatcherService().match(strictSonyRule, candidate);

    assert.equal(decision.category, "REJECTED");
    assert.equal(decision.comparable, false);
  });
}
```

Add a pure-Han assertion so this targeted exception cannot turn Chinese aliases into substring matches:

```ts
test("keeps a pure-Han model bounded inside longer Chinese text", () => {
  const candidate = sonyOffer("小羚羊 单机");
  candidate.title = "专业音频接口";
  const hanOnlyRule = {
    ...strictSonyRule,
    brand: "Antelope",
    standardModel: "羚羊"
  };

  const decision = new MatcherService().match(hanOnlyRule, candidate);

  assert.equal(decision.category, "REJECTED");
  assert.equal(decision.comparable, false);
});
```

- [ ] **Step 2: Run the focused matcher test and verify RED**

Run:

```bash
node --test apps/api/src/matching/matcher.service.spec.ts
```

Expected: the Chinese-adjacency case fails because the current Unicode letter boundary treats Han as a model continuation; existing exact and punctuation cases remain green.

- [ ] **Step 3: Implement the minimal model-aware boundary**

In `containsBoundedModelPhrase`, detect whether any normalized token contains a Latin-script character or number. For such phrases, use a boundary that accepts either a non-letter/non-number or a Han character; for pure-Han phrases, keep the existing strict Unicode boundary. Use a lookahead for the trailing edge so the separator is not consumed:

```ts
const hasModelCodeToken = tokens.some((token) => /[\p{Script=Latin}\p{N}]/u.test(token));
const edge = hasModelCodeToken
  ? "(?:[^\\p{L}\\p{N}]|\\p{Script=Han})"
  : "[^\\p{L}\\p{N}]";
return new RegExp(
  `(?:^|${edge})${modelPattern}(?=$|${edge})`,
  "u"
).test(normalizeText(haystack));
```

- [ ] **Step 4: Run the focused matcher test and verify GREEN**

Run:

```bash
node --test apps/api/src/matching/matcher.service.spec.ts
```

Expected: all matcher tests pass, including Chinese adjacency, pure-Han strictness, punctuation, and continuation rejection.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/api/src/matching/matcher.service.spec.ts apps/api/src/matching/matcher.service.ts
git commit -m "fix: recognize models beside Chinese text"
```

---

### Task 2: Quarantine a Deterministically Invalid Post-Run Checkpoint

**Files:**
- Modify: `apps/collector/src/agent/collector-worker.spec.ts`
- Modify: `apps/collector/src/agent/collector-worker.ts`

**Interfaces:**
- Consumes: `safeErrorCode(error: unknown): string`, `CollectorWorkerApi.release(runId, input?)`
- Produces: `QUARANTINE` release only when the second checkpoint load reports `INVALID_CHECKPOINT`; all other load errors keep ordinary release semantics.

- [ ] **Step 1: Write failing second-load classification tests**

Add one test where the first checkpoint load used by the heartbeat succeeds and the second, post-run load throws a coded deterministic error:

```ts
test("quarantines an invalid post-run checkpoint without deleting evidence", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  const uploader = new FakeUploader();
  const originalLoad = store.load.bind(store);
  store.load = async () => {
    if (store.loadCalls === 1) {
      store.loadCalls += 1;
      throw Object.assign(new TypeError("invalid checkpoint"), {
        code: "INVALID_CHECKPOINT" as const
      });
    }
    return originalLoad();
  };
  const { worker } = createWorker({ api, store, uploader });

  await assert.rejects(() => worker.once(), { code: "CHECKPOINT_FAILED" });
  assert.deepEqual(api.releaseInputs, [{
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  }]);
  assert.equal(store.removeCalls, 0);
  assert.equal(uploader.clearCalls, 0);
});
```

Add a companion test whose second load throws an uncoded error and retains ordinary release behavior:

```ts
test("requeues an unknown post-run checkpoint load failure without deleting evidence", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  const uploader = new FakeUploader();
  const originalLoad = store.load.bind(store);
  store.load = async () => {
    if (store.loadCalls === 1) {
      store.loadCalls += 1;
      throw new Error("temporary checkpoint read failure");
    }
    return originalLoad();
  };
  const { worker } = createWorker({ api, store, uploader });

  await assert.rejects(() => worker.once(), { code: "CHECKPOINT_FAILED" });
  assert.deepEqual(api.releaseInputs, [undefined]);
  assert.equal(store.removeCalls, 0);
  assert.equal(uploader.clearCalls, 0);
});
```

- [ ] **Step 2: Run the focused worker test and verify RED**

Run:

```bash
node --test apps/collector/src/agent/collector-worker.spec.ts
```

Expected: the deterministic second-load test fails because the worker currently performs an ordinary release.

- [ ] **Step 3: Implement minimal post-run load classification**

Change only the catch around `checkpointStore.load(job.runId)`:

```ts
} catch (error) {
  this.activeController = null;
  if (safeErrorCode(error) === "INVALID_CHECKPOINT") {
    await this.release(job.runId, {
      disposition: "QUARANTINE",
      errorCode: "INVALID_CHECKPOINT"
    });
  } else {
    await this.release(job.runId);
  }
  throw new CollectorWorkerError("CHECKPOINT_FAILED");
}
```

- [ ] **Step 4: Run the focused worker test and verify GREEN**

Run:

```bash
node --test apps/collector/src/agent/collector-worker.spec.ts
```

Expected: all worker tests pass; deterministic corruption quarantines and unknown load errors requeue.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/collector/src/agent/collector-worker.spec.ts apps/collector/src/agent/collector-worker.ts
git commit -m "fix: quarantine invalid checkpoint reloads"
```

---

### Task 3: Align Desktop Report Integration Fixtures

**Files:**
- Modify: `apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts`

**Interfaces:**
- Consumes: the production `taobao-desktop` provider profile requiring macOS plus `accessibility`, `all-sku`, and `png-evidence`.
- Produces: two claim fixtures that advertise the exact required capability set.

- [ ] **Step 1: Update both stale claim fixtures**

At both existing `claimNext` calls in this integration spec, replace the stale list with:

```ts
capabilities: ["accessibility", "all-sku", "png-evidence"]
```

Do not alter production provider requirements or add database setup.

- [ ] **Step 2: Verify the fixture occurrences statically**

Run:

```bash
rg -n -C 2 'capabilities:' apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts
```

Expected: both relevant claims show the exact three capabilities and no stale one-capability claim remains in this file.

- [ ] **Step 3: Run TypeScript validation**

Run:

```bash
pnpm typecheck
```

Expected: PASS. Do not run the database-backed integration spec in this cycle.

- [ ] **Step 4: Commit Task 3**

```bash
git add apps/api/src/collection/prisma-desktop-report.repository.integration.spec.ts
git commit -m "test: align desktop claim capabilities"
```

---

### Task 4: Scoped Review and Safe Verification

**Files:**
- Review: all files changed since the design commit.
- Update: this plan's SDD ledger only; do not add runtime behavior.

**Interfaces:**
- Consumes: commits from Tasks 1-3.
- Produces: an independent clean review or a bounded fix/re-review cycle, plus fresh verification evidence.

- [ ] **Step 1: Generate a review package and run an independent whole-change review**

Review for behavioral regressions, error-classification mistakes, over-broad Unicode matching, stale capability fixtures, and missing tests. Findings must include file and line references.

- [ ] **Step 2: Resolve review findings through the bounded SDD fix loop**

Apply fixes test-first where production behavior changes, then request scoped re-review. Do not claim completion while any load-bearing finding remains.

- [ ] **Step 3: Run focused and portable verification**

Run:

```bash
node --test apps/api/src/matching/matcher.service.spec.ts
node --test apps/collector/src/agent/collector-worker.spec.ts
pnpm test:portable
pnpm build
git diff --check
git status --short --branch
```

Expected: all permitted tests and the build pass, `git diff --check` is empty, and the branch has no uncommitted changes. Database and Redis dependent tests are intentionally excluded.

- [ ] **Step 4: Record verification without exposing live data**

Record only test counts/status, build status, review verdict, and the known database-integration test gap. Do not record live product or account data.
