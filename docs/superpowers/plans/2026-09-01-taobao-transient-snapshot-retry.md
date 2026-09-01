# Taobao Transient Result Snapshot Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a submitted Taobao Desktop search to survive a transient post-Return `NODE_NOT_FOUND` snapshot without repeating any mutation.

**Architecture:** Keep the recovery entirely inside `TaobaoMacDriver.waitForStableSearch`. The existing deadline and stable-observation gate remain authoritative; only the exact helper response code `NODE_NOT_FOUND` is treated like a temporarily unrecognized result tree, while every mutation and every other helper error keeps its current behavior.

**Tech Stack:** TypeScript, Node.js test runner, macOS Accessibility helper, Swift Package Manager.

## Global Constraints

- Recover only `AxHelperResponseError` with exact code `NODE_NOT_FOUND` while `waitForStableSearch` is observing results.
- Keep `STABILITY_TIMEOUT_MS = 15_000`, `STABLE_OBSERVATION_COUNT = 3`, and `POLL_INTERVAL_MS = 250` unchanged.
- Never retry `activate`, `replaceText`, `setValue`, `keyPress`, or `perform`.
- A transient snapshot clears consecutive stability state and may latch the initial transition only through the existing `allowLatchedTransition` rule.
- Persistent transient failures end with the existing 15-second stability timeout.
- Other helper response errors propagate immediately.
- Do not change API, queue, persistence, database, scheduling, Enterprise WeChat, notification, repricing, or collection-run behavior.
- Do not run either live search until three separate diagnoses complete successfully.
- Live probe output is limited to counts, termination reasons, booleans, and supported-link counts.

---

### Task 1: Retry Only Transient Result Snapshots

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts:14-21,582-618`
- Test: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts:1-70,276`

**Interfaces:**
- Consumes: `AxHelperResponseError.code`, `TaobaoAxClient.snapshot()`, and the existing `waitForStableSearch(query, preActionSignature, allowLatchedTransition)` loop.
- Produces: unchanged `Promise<AxNode>` behavior after one or more recoverable `NODE_NOT_FOUND` observations.

- [ ] **Step 1: Extend the live fake client so snapshots can throw exact helper errors**

Import the concrete response error and permit queued `Error` instances:

```typescript
import {
  AxHelperResponseError,
  type AxHelperCommandFields,
  type AxHelperCommandName,
  type AxHelperDiagnosticPayload
} from "./ax-helper-client.ts";

readonly snapshotQueue: Array<AxNode | Error> = [];

async snapshot(): Promise<AxNode> {
  const next = this.snapshotQueue.shift();
  if (!next) throw new Error("Fake snapshot queue is empty");
  if (next instanceof Error) throw next;
  this.activeRoot = structuredClone(next);
  return structuredClone(this.activeRoot);
}
```

- [ ] **Step 2: Add the three focused failing tests**

Add these cases beside the existing live search submission tests:

```typescript
function missingNodeError(): AxHelperResponseError {
  return new AxHelperResponseError(
    "NODE_NOT_FOUND",
    "Accessibility node was not found."
  );
}

test("retries a transient missing result node without resubmitting the live query", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    missingNodeError(),
    ...stable(search)
  );

  const result = await driver.search(QUERY, 1);

  assert.equal(result.positions.length, 1);
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "replaceText", "keyPress"]
  );
});

test("times out persistent missing result nodes without resubmitting the live query", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    ...Array.from({ length: 61 }, missingNodeError)
  );

  await assert.rejects(
    driver.search(QUERY, 1),
    (error: unknown) => error instanceof UiContractChangedError
      && error.message === "Taobao search results did not transition and stabilize within 15 seconds."
  );
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "replaceText", "keyPress"]
  );
});

test("does not retry a different helper response error while observing live results", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const fatal = new AxHelperResponseError("APP_NOT_RUNNING", "Application is not running.");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    fatal
  );

  await assert.rejects(driver.search(QUERY, 1), (error: unknown) => error === fatal);
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "replaceText", "keyPress"]
  );
});
```

- [ ] **Step 3: Run the focused test file and verify RED**

Run from `apps/collector` with the bundled Node path:

```bash
node --test src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: the transient-recovery and persistent-timeout tests fail because
`NODE_NOT_FOUND` currently escapes the observation loop; the unrelated-error
test passes.

- [ ] **Step 4: Implement the narrow recovery inside the existing loop**

Import `AxHelperResponseError` in `taobao-mac-driver.ts`, move the snapshot
inside the loop's existing `try`, and use this catch block:

```typescript
      } catch (error) {
        const transientMissingNode = error instanceof AxHelperResponseError
          && error.code === "NODE_NOT_FOUND";
        if (!transientMissingNode && !(error instanceof UiContractChangedError)) {
          throw error;
        }
        if (allowLatchedTransition) sawTransition = true;
        previous = "";
        consecutive = 0;
      }
```

Do not add another loop, retry counter, mutation call, or timeout.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: all tests in the file pass, including all three new cases.

- [ ] **Step 6: Run the collector suite and typecheck**

Run separately from the repository root:

```bash
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: 292 collector tests pass, typecheck passes, and no whitespace errors are reported.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
git commit -m "fix: retry transient Taobao result snapshots"
```

---

### Task 2: Verify The Fix With Non-Persistent Live Probes

**Files:**
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/native-search-probe.mts`
- Create, run, then delete without committing: `.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/final-state-probe.mts`
- Modify, ignored evidence only: `.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/task-2-report.md`

**Interfaces:**
- Consumes: the Task 1 driver and existing `AxHelperClient`.
- Produces: automated verification evidence, two sanitized search summaries, and a final read-only state summary.

- [ ] **Step 1: Rebuild and run all automated verification**

Run separately:

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk CLANG_MODULE_CACHE_PATH=/tmp/stau-clang-module-cache SWIFTPM_MODULECACHE_OVERRIDE=/tmp/stau-swiftpm-module-cache swift build --package-path apps/collector-macos
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
git status --short --branch
```

Expected: the Swift production helper builds; 292 collector tests and
typecheck pass; the tracked tree is clean. Record that local XCTest remains
unavailable because the installed Command Line Tools contain neither XCTest
nor Testing and the default SDK/compiler pair is mismatched.

- [ ] **Step 2: Run the diagnosis safety gate three separate times**

```bash
pnpm collector:diagnose
pnpm collector:diagnose
pnpm collector:diagnose
```

Each command must exit 0 with `diagnose_complete` before any search runs. Run
outside the restricted network sandbox so the configured loopback API is
reachable.

- [ ] **Step 3: Create the exact two-search probe**

```typescript
import { AxHelperClient } from "../../../apps/collector/src/drivers/macos/ax-helper-client.ts";
import { TaobaoMacDriver } from "../../../apps/collector/src/drivers/macos/taobao-mac-driver.ts";

const client = new AxHelperClient();
const driver = new TaobaoMacDriver({ client });

try {
  const own = await driver.search(
    "https://detail.tmall.com/item.htm?id=550902914950",
    1
  );
  const model = await driver.search("RME Babyface Pro FS", 1);
  console.log(JSON.stringify({
    ownPositions: own.positions.length,
    ownTerminationReason: own.terminationReason,
    modelPositions: model.positions.length,
    modelTerminationReason: model.terminationReason
  }));
} finally {
  client.close();
}
```

- [ ] **Step 4: Run the probe from the collector package**

```bash
node --import=tsx ../../.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/native-search-probe.mts
```

Expected: both searches return one position with `LIMIT_REACHED`. Do not print
titles, shops, URLs, prices, query text, or raw accessibility trees.

- [ ] **Step 5: Capture the final state with a read-only probe**

Create `final-state-probe.mts` with this exact program:

```typescript
import {
  LoginRequiredError,
  PlatformChallengeError
} from "../../../apps/collector/src/core/desktop-driver.ts";
import { AxHelperClient } from "../../../apps/collector/src/drivers/macos/ax-helper-client.ts";
import {
  assertNoStopState,
  findSearchField,
  readSearchCards,
  readSearchResultQuery
} from "../../../apps/collector/src/drivers/macos/taobao-selectors.ts";

const expected = "RME Babyface Pro FS";
const client = new AxHelperClient();

try {
  const root = await client.snapshot();
  let loginOrChallengePresent = false;
  try {
    assertNoStopState(root);
  } catch (error) {
    if (error instanceof LoginRequiredError || error instanceof PlatformChallengeError) {
      loginOrChallengePresent = true;
    } else {
      throw error;
    }
  }
  const field = findSearchField(root);
  const resultQuery = readSearchResultQuery(root);
  console.log(JSON.stringify({
    snapshotRead: true,
    queryAndFieldAgree: field.value === expected && resultQuery === expected,
    supportedItemLinkCount: readSearchCards(root).length,
    loginOrChallengePresent
  }));
} catch {
  console.log(JSON.stringify({
    snapshotRead: false,
    queryAndFieldAgree: false,
    supportedItemLinkCount: null,
    loginOrChallengePresent: null
  }));
  process.exitCode = 1;
} finally {
  client.close();
}
```

Run from `apps/collector`:

```bash
node --import=tsx ../../.superpowers/sdd/2026-09-01-taobao-transient-snapshot-retry/final-state-probe.mts
```

Expected: `snapshotRead=true`, `queryAndFieldAgree=true`,
`supportedItemLinkCount >= 1`, and `loginOrChallengePresent=false`.

- [ ] **Step 6: Delete both temporary probes and record safety evidence**

Delete both files with `apply_patch`, verify both are absent, and record only
sanitized counts, termination reasons, and booleans in the report. Explicitly
record zero API runs, zero queue or persistence writes, zero Enterprise WeChat
sends, zero notifications, zero repricing actions, and zero collection runs.

Do not commit ignored SDD evidence.

---

## Completion Gate

The change is complete only when Task 1 passes task review, all automated
verification is green except the documented local XCTest toolchain limitation,
three diagnoses pass, both live probes return one stable position, the final
snapshot agrees with the model query, and final whole-branch review has no
Critical or Important findings.
