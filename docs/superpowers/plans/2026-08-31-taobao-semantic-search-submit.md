# Taobao Semantic Search Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Taobao Desktop searches submit through verified macOS accessibility actions so a written query reliably transitions the live result page without depending on keyboard focus.

**Architecture:** Add a profile-aware `findSearchSubmitAction` selector that returns `AXConfirm` for the synthetic fixture profile and a unique exact-title `搜索` button with `AXPress` for the live profile. The driver will write the query, take a fresh snapshot, verify the written value and all stop states, perform the returned accessibility action using the exact path and fingerprint, and then reuse the existing stable-result transition logic.

**Tech Stack:** TypeScript, Node.js test runner, pnpm workspace, macOS Accessibility API helper, Taobao Desktop 2.4.5 build 15, NestJS local API.

## Global Constraints

- Live submission must use `AXPress` on exactly one enabled `AXButton` whose normalized visible text is exactly `搜索` inside the unique `https://s.taobao.com/search` web area.
- Synthetic submission must use `AXConfirm` on the unique enabled profiled search field.
- Do not send Return key code `36` to submit a search.
- Take a fresh snapshot after `setValue`, repeat existing stop-state checks, and verify the normalized field value exactly matches the normalized requested query before any submit action.
- Missing, duplicate, disabled, non-actionable, stale, or changed controls must throw `UiContractChangedError` and stop safely.
- Preserve all existing login, challenge, stable-transition, rank, duplicate-position, sponsored-position, item-identity, SKU, and UI-drift safeguards.
- Do not change APIs, database schema, report shape, scheduling, Enterprise WeChat behavior, or repricing behavior.
- Do not print `.env`, API tokens, collector tokens, cookies, or other secrets.
- Run a real RME Babyface Pro FS three-position pilot only after focused tests, the full collector suite, type checking, diff checks, and live diagnosis all pass.
- The pilot must have notifications disabled and must never change a price.

---

### Task 1: Define and Test the Profile-Aware Submit Action

**Files:**
- Modify: `apps/collector/test/fixtures/ax/live-search-results.json`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`

**Interfaces:**
- Consumes: `AxNode`, `axNodeText(node: AxNode): string | null`, `walkAxNodes(root: AxNode): AxNode[]`, `taobaoSelectorProfile(root): "SYNTHETIC" | "LIVE"`.
- Produces: `SearchSubmitAction` and `findSearchSubmitAction(root: AxNode): SearchSubmitAction`.
- `SearchSubmitAction` is exactly `{ node: AxNode; action: "AXConfirm" | "AXPress" }`.
- Produces for the live selector boundary: `liveFindSearchSubmitButton(root: AxNode): AxNode`.

- [ ] **Step 1: Add a runtime-shaped live search button to the sanitized fixture**

Add this node as the second child of the existing search-control group in `live-search-results.json`, after the `AXTextField`. Its path must be `[0, 0, 0, 1]`:

```json
{
  "path": [0, 0, 0, 1],
  "role": "AXButton",
  "subrole": null,
  "identifier": null,
  "title": "搜索",
  "description": null,
  "value": null,
  "url": null,
  "enabled": true,
  "selected": null,
  "position": null,
  "size": null,
  "actions": ["AXPress"],
  "children": []
}
```

- [ ] **Step 2: Write live selector tests for the exact semantic button contract**

Import `findSearchSubmitAction` through the public `taobao-selectors.ts` wrapper. Add a positive test:

```typescript
test("selects the unique enabled live search button with AXPress", async () => {
  const root = await fixture("live-search-results.json");
  const submit = findSearchSubmitAction(root);

  assert.equal(submit.action, "AXPress");
  assert.equal(submit.node.role, "AXButton");
  assert.equal(submit.node.title, "搜索");
  assert.deepEqual(submit.node.path, [0, 0, 0, 1]);
});
```

Add a table-driven negative test. Each mutation must throw `UiContractChangedError`:

```typescript
test("rejects missing duplicate disabled and non-actionable live search buttons", async () => {
  const base = await fixture("live-search-results.json");
  const cases: Array<[string, (root: AxNode) => void]> = [
    ["missing", (root) => { searchArea(root).children[0]!.children.splice(1, 1); }],
    ["duplicate", (root) => {
      searchArea(root).children.push(axNode([0, 0, 2], {
        role: "AXButton",
        title: "搜索",
        enabled: true,
        actions: ["AXPress"]
      }));
    }],
    ["disabled", (root) => {
      const button = walkAxNodes(root).find((node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      button.enabled = false;
    }],
    ["non-actionable", (root) => {
      const button = walkAxNodes(root).find((node) => node.role === "AXButton" && node.title === "搜索");
      assert.ok(button);
      button.actions = [];
    }]
  ];

  for (const [name, mutate] of cases) {
    const root = structuredClone(base);
    mutate(root);
    assert.throws(() => findSearchSubmitAction(root), UiContractChangedError, name);
  }
});
```

Use the file's existing `searchArea`, `axNode`, `AxNode`, and `UiContractChangedError` helpers/imports, and add `walkAxNodes` to the existing import from `ax-node.ts`.

- [ ] **Step 3: Write synthetic selector tests for `AXConfirm`**

In `taobao-selectors.spec.ts`, import `UiContractChangedError`, `walkAxNodes`, and `findSearchSubmitAction`. Add:

```typescript
test("uses AXConfirm on the profiled synthetic search field", async () => {
  const root = await fixture("search-results.json");
  const submit = findSearchSubmitAction(root);

  assert.equal(submit.action, "AXConfirm");
  assert.equal(submit.node.identifier, "search-input");
  assert.deepEqual(submit.node.path, [0, 0, 0]);
});

test("rejects a synthetic search field without AXConfirm", async () => {
  const root = structuredClone(await fixture("search-results.json"));
  const field = walkAxNodes(root).find((node) => node.identifier === "search-input");
  assert.ok(field);
  field.actions = [];

  assert.throws(() => findSearchSubmitAction(root), UiContractChangedError);
});
```

- [ ] **Step 4: Run the focused selector tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 \
  apps/collector/src/drivers/macos/taobao-selectors.spec.ts \
  apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the new tests fail because `findSearchSubmitAction` is not yet exported. A fixture parse error, unrelated regression, permission failure, or loader failure is not an acceptable RED result.

- [ ] **Step 5: Implement the strict live button selector**

In `taobao-live-selectors.ts`, add this export beside `liveFindSearchField`:

```typescript
export function liveFindSearchSubmitButton(root: AxNode): AxNode {
  const searchArea = uniqueSearchWebArea(root);
  const candidates = walkAxNodes(searchArea).filter((node) =>
    node.role === "AXButton" && normalizeText(axNodeText(node) ?? "") === "搜索");
  if (candidates.length !== 1) return profileError();
  const button = candidates[0] ?? profileError();
  if (button.enabled !== true || !button.actions.includes("AXPress")) return profileError();
  return button;
}
```

This intentionally counts all exact-title candidates before validating enabled state and actions, so one valid button plus one invalid duplicate still fails closed.

- [ ] **Step 6: Implement the profile-aware public selector**

Import `liveFindSearchSubmitButton` into `taobao-selectors.ts`. Add:

```typescript
export interface SearchSubmitAction {
  node: AxNode;
  action: "AXConfirm" | "AXPress";
}

function syntheticFindSearchSubmitAction(root: AxNode): SearchSubmitAction {
  const field = syntheticFindSearchField(root);
  if (field.enabled !== true || !field.actions.includes("AXConfirm")) return profileError();
  return { node: field, action: "AXConfirm" };
}

export function findSearchSubmitAction(root: AxNode): SearchSubmitAction {
  assertNoStopState(root);
  if (taobaoSelectorProfile(root) === "SYNTHETIC") {
    return syntheticFindSearchSubmitAction(root);
  }
  return { node: liveFindSearchSubmitButton(root), action: "AXPress" };
}
```

- [ ] **Step 7: Run the focused selector tests and verify GREEN**

Run the Step 4 command again.

Expected: every test in both selector files passes, including all new positive and fail-closed cases.

- [ ] **Step 8: Commit the selector contract**

```bash
git add \
  apps/collector/test/fixtures/ax/live-search-results.json \
  apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts \
  apps/collector/src/drivers/macos/taobao-selectors.spec.ts \
  apps/collector/src/drivers/macos/taobao-live-selectors.ts \
  apps/collector/src/drivers/macos/taobao-selectors.ts
git commit -m "feat: select semantic Taobao search submit action"
```

---

### Task 2: Submit Search After a Fresh Verified Snapshot

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`

**Interfaces:**
- Consumes: `findSearchSubmitAction(root: AxNode): SearchSubmitAction` from Task 1.
- Preserves: `TaobaoMacDriver.search(query: string, limit: number): Promise<DriverSearchResult>`.
- Performs: `client.command("perform", { nodePath, action, fingerprint })` after post-write validation.
- Adds no public API or persistence interface.

- [ ] **Step 1: Add a post-write snapshot helper to both driver specs**

Keep the existing three-observation `stable` helper unchanged. Add:

```typescript
function postWriteThenStable(root: AxNode): AxNode[] {
  return [root, ...stable(root)];
}
```

For every test queue that starts a search, replace the post-initial `...stable(search)` segment with `...postWriteThenStable(search)`. The first item is consumed by the new post-`setValue` verification snapshot; the remaining three satisfy `STABLE_OBSERVATION_COUNT` after the submit action. Do not change detail-page or return-to-search stability queues.

Use these searches to audit all affected queues before running tests:

```bash
rg -n "snapshotQueue\.push\(.*Previous Query|withResultQuery\(.*旧查询|stable\(search\)" \
  apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts \
  apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts
```

- [ ] **Step 2: Change the live driver expectation to semantic `AXPress`**

In the live paging test, expect:

```typescript
assert.deepEqual(client.commands.map(({ command, fields }) => [
  command,
  fields.action ?? fields.keyCode ?? fields.value
]), [
  ["setValue", QUERY],
  ["perform", "AXPress"],
  ["keyPress", 121]
]);

assert.deepEqual(client.commands[1], {
  command: "perform",
  fields: {
    nodePath: [0, 0, 0, 1],
    action: "AXPress",
    fingerprint: { role: "AXButton", title: "搜索" }
  }
});
assert.equal(client.commands.some(({ command, fields }) =>
  command === "keyPress" && fields.keyCode === 36), false);
```

Retain the existing exact `setValue` raw-target assertion.

- [ ] **Step 3: Change the synthetic driver expectation to semantic `AXConfirm`**

In `searches semantically and preserves duplicate result positions`, expect:

```typescript
assert.deepEqual(client.commands.map((entry) => [entry.command, entry.fields.action ?? entry.fields.value]), [
  ["setValue", "索尼 7506"],
  ["perform", "AXConfirm"]
]);
assert.deepEqual(client.commands[1], {
  command: "perform",
  fields: {
    nodePath: [0, 0, 0],
    action: "AXConfirm",
    fingerprint: { role: "AXTextField", identifier: "search-input" }
  }
});
assert.equal(client.commands.some(({ command, fields }) =>
  command === "keyPress" && fields.keyCode === 36), false);
```

- [ ] **Step 4: Add a post-write mismatch fail-closed test**

Add this focused test in `taobao-mac-driver-live.spec.ts`:

```typescript
test("does not submit when the freshly observed search value differs from the request", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    withSearchQuery(search, "Different Query")
  );

  await assert.rejects(driver.search(QUERY, 1), UiContractChangedError);
  assert.deepEqual(client.commands.map(({ command }) => command), ["setValue"]);
});
```

- [ ] **Step 5: Run the focused driver tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 \
  apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts \
  apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: semantic submit expectations fail because the driver still sends Return key code `36`; the mismatch test also fails because the old driver does not perform the fresh post-write validation. Queue exhaustion caused by a missed search queue update must be corrected before accepting the RED result.

- [ ] **Step 6: Add normalized query comparison in the driver**

Near the other private module helpers in `taobao-mac-driver.ts`, add:

```typescript
function normalizedSearchValue(value: AxJsonValue): string | null {
  if (typeof value !== "string") return null;
  return value.trim().replace(/\s+/g, " ");
}
```

The requested query comparison uses `query.trim().replace(/\s+/g, " ")`. It does not alter the original value sent to Taobao or the exact query later required by the existing stable-result checks.

- [ ] **Step 7: Replace Return with a fresh verified semantic action**

Import `findSearchSubmitAction` from `taobao-selectors.ts`. Replace the current Return command immediately after `setValue` with:

```typescript
const postWrite = await this.client.snapshot();
assertNoStopState(postWrite);
const postWriteField = findSearchField(postWrite);
const requestedValue = query.trim().replace(/\s+/g, " ");
if (normalizedSearchValue(postWriteField.value) !== requestedValue) {
  throw new UiContractChangedError("Taobao search field did not retain the requested query.");
}
const submit = findSearchSubmitAction(postWrite);
await this.client.command("perform", {
  nodePath: submit.node.path,
  action: submit.action,
  fingerprint: fingerprintFor(submit.node)
});
```

Do not catch this error, retry the click, focus the field, or fall back to Return.

- [ ] **Step 8: Run the focused driver tests and verify GREEN**

Run the Step 5 command again.

Expected: both driver files pass; live commands contain `AXPress`, synthetic commands contain `AXConfirm`, and no search-submit command uses key code `36`.

- [ ] **Step 9: Commit the driver repair**

```bash
git add \
  apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts \
  apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts \
  apps/collector/src/drivers/macos/taobao-mac-driver.ts
git commit -m "fix: submit Taobao search through AX action"
```

---

### Task 3: Run the Complete Automated Regression Gate

**Files:**
- No intended tracked changes.

**Interfaces:**
- Collector suite: `pnpm test:collector`.
- Collector compiler gate: `pnpm --filter @stau-price-monitor/collector typecheck`.
- Repository whitespace gate: `git diff --check`.

- [ ] **Step 1: Run the full collector suite**

```bash
pnpm test:collector
```

Expected: every collector test passes. Any stale queue, login/challenge, rank, SKU, item-identity, or AX fingerprint failure must be fixed at its source; do not weaken the assertion.

- [ ] **Step 2: Run collector type checking**

```bash
pnpm --filter @stau-price-monitor/collector typecheck
```

Expected: TypeScript exits successfully with no diagnostics.

- [ ] **Step 3: Run diff and scope checks**

```bash
git diff --check
git status --short
git diff --stat HEAD~2..HEAD
```

Expected: no whitespace errors; only the five selector/fixture files and three driver/test files from Tasks 1 and 2 are changed across the two implementation commits; no API, schema, notification, scheduling, or repricing file appears.

- [ ] **Step 4: Record automated evidence without secrets**

Record the focused selector count, focused driver count, full collector count, typecheck result, commit hashes, and scope-check result in the implementation completion report. Do not record environment values or tokens.

---

### Task 4: Diagnose the Real App and Run One Supervised Three-Position Pilot

**Files:**
- No intended tracked changes.
- Uses ignored local `.env`, `.env.collector`, collector evidence, PostgreSQL, Redis, and the existing pilot model.

**Interfaces:**
- API health: `GET http://127.0.0.1:4101/api/health`.
- Collector diagnosis: `COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:diagnose`.
- Existing monitored model ID: `cmtgvjas900000v04ui39z8fs`.
- Pilot query: `RME Babyface`; requested search limit: `3`.
- One-shot worker: `COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:once`.

- [ ] **Step 1: Verify API and local dependencies without exposing secrets**

Check the already running API first:

```bash
curl --fail --silent http://127.0.0.1:4101/api/health
```

Expected: healthy database, Redis, queue, collector-agent, and runtime state. If port `4101` is no longer serving, restart from the worktree in a dedicated terminal with:

```bash
DOTENV_CONFIG_PATH="$PWD/.env" \
API_PORT=4101 \
PUBLIC_BASE_URL=http://127.0.0.1:4101 \
pnpm dev:api
```

- [ ] **Step 2: Run three consecutive live diagnoses**

With Taobao Desktop 2.4.5 build 15 logged in and frontmost, run this command three separate times:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:diagnose
```

Expected each time: terminal state `diagnose_complete`. Stop on login loss, challenge, permission failure, unsupported build, or UI-contract change. Never bypass a Taobao verification prompt.

- [ ] **Step 3: Enqueue exactly one replacement pilot from the local admin UI**

Open the local catalog/admin page, select model ID `cmtgvjas900000v04ui39z8fs`, confirm its query is `RME Babyface`, choose manual collection with `searchLimit = 3`, and submit once. Capture the returned run ID and confirm it is not coalesced into either prior failed run `cmtgvk69g00030v04k1jvwl7s` or `cmtgvonum00070v043ooq5fc9`.

The equivalent request generated by the UI is:

```http
POST /api/collection-runs
Content-Type: application/json

{"monitoredModelId":"cmtgvjas900000v04ui39z8fs","searchLimit":3}
```

Use the authenticated UI session; do not print or manually paste its admin token.

- [ ] **Step 4: Run one supervised collection**

Keep Taobao Desktop frontmost and run:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:once
```

Expected: the search field changes to `RME Babyface`, the unique `搜索` button is pressed, the result page transitions, and the worker processes no more than the first three displayed positions. Stop on any login, challenge, identity, stale-control, no-progress, or UI-contract error.

- [ ] **Step 5: Review the run before any external action**

Open `/runs/<new-run-id>` in the local web app and verify:

- ranks 1 through 3 remain in displayed order, including duplicates and sponsored positions;
- each position records shop, item link, displayed price range, and raw evidence;
- every accessible SKU combination records selected labels, activity price, stock, and promotions;
- lower-price competitors and missing own SKU combinations are separated;
- notification attempts remain `0`, notification state is not sent, and no price-change operation occurred.

Report the run ID, terminal state, position count, lowest verified comparison, and any blocked or review-required SKU evidence. Do not send Enterprise WeChat from this pilot.
