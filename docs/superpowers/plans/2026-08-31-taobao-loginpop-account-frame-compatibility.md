# Taobao loginPop Account Frame Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating Taobao Desktop's logged-in `pages/loginPop/index.html` account-management frame as a login page while preserving every existing login and challenge stop condition.

**Architecture:** Keep the fix inside the live macOS accessibility selector boundary. Add regression coverage through the public selector wrapper, then extend only the approved local account-management path predicate; title and descendant-control evidence remain mandatory before a frame is exempted.

**Tech Stack:** TypeScript, Node.js test runner, pnpm workspace, macOS Accessibility API helper, NestJS local API.

## Global Constraints

- Modify production behavior only in `apps/collector/src/drivers/macos/taobao-live-selectors.ts`.
- Add regression coverage only in `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`.
- Follow strict TDD: observe the new positive `登陆` title test fail with `LoginRequiredError` before changing production code.
- Accept only local `file:` URLs ending in either `account-panel/loginPop/index.html` or `pages/loginPop/index.html`.
- Approved account-management titles are `账号管理`, `Account Settings`, and `登陆`.
- Never exempt a frame based on path or title alone. `AXWebArea`, `file:`, exact approved path, approved title, sign-out text, and switch-account text all remain required.
- HTTP/HTTPS login URLs, login dialogs, challenge URLs, challenge dialogs, and incomplete local account frames must continue to stop collection.
- Do not change collection logic, SKU parsing, database schema, report generation, Enterprise WeChat behavior, or repricing behavior.
- Do not print `.env`, API tokens, collector tokens, or other secrets.
- Run the real RME Babyface smoke collection only after diagnostics return `diagnose_complete`, with the operator present, and without sending Enterprise WeChat notifications.

---

### Task 1: Add the Real loginPop Path Regression

**Files:**
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts:119-143`

**Interfaces:**
- Exercises: `assertNoStopState(root: AxNode): void` through `taobao-selectors.ts`.
- Expected failure before the fix: `LoginRequiredError` for the confirmed `pages/loginPop/index.html` account-management frame.

- [ ] **Step 1: Add a passing-state regression test for the real path**

Add this test beside the existing account-management tests:

```typescript
test("ignores the Taobao pages/loginPop account-management frame when logged-in controls are present", () => {
  const root = stopStateRoot(axNode([1], {
    role: "AXWebArea",
    title: "账号管理",
    url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
    children: [
      axNode([1, 0], { role: "AXButton", title: "退出登录" }),
      axNode([1, 1], { role: "AXButton", title: "切换账号" })
    ]
  }));

  assert.doesNotThrow(() => assertNoStopState(root));
});
```

- [ ] **Step 2: Add exact-path negative coverage for either missing confirmation control**

Add a table-driven guard using the same `pages/loginPop/index.html` URL:

```typescript
test("does not exempt the Taobao pages/loginPop frame when either logged-in control is missing", () => {
  for (const onlyControl of ["退出登录", "切换账号"] as const) {
    const root = stopStateRoot(axNode([1], {
      role: "AXWebArea",
      title: "账号管理",
      url: "file:///Applications/Taobao.app/Contents/Resources/app/pages/loginPop/index.html",
      children: [axNode([1, 0], { role: "AXButton", title: onlyControl })]
    }));

    assert.throws(() => assertNoStopState(root), LoginRequiredError, onlyControl);
  }
});
```

- [ ] **Step 3: Run the focused selector test and verify RED**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: the new positive `pages/loginPop` test fails because `assertNoStopState` throws `LoginRequiredError`. The new negative guard and existing tests should pass. A loader, syntax, fixture, or permission error is not an acceptable RED result.

---

### Task 2: Make the Minimal Approved Path Change

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts:14-20,308-319`
- Test: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`

**Interfaces:**
- Preserves: `liveAssertNoStopState(root: AxNode): void`.
- Changes only: the private approved-path check used by `isConfirmedAccountManagementFrame`.

- [ ] **Step 1: Add one exact approved-path constant**

Near the account-management title constants, add:

```typescript
const ACCOUNT_MANAGEMENT_PATH = /\/(?:account-panel|pages)\/loginPop\/index\.html$/i;
```

- [ ] **Step 2: Use the path constant without weakening the evidence gate**

Make only this predicate substitution:

```typescript
function isConfirmedAccountManagementFrame(node: AxNode): boolean {
  const parsed = parseUrl(node.url);
  if (node.role !== "AXWebArea" || parsed?.protocol !== "file:"
    || !ACCOUNT_MANAGEMENT_PATH.test(parsed.pathname)
    || !ACCOUNT_MANAGEMENT_TITLES.has(node.title?.trim() ?? "")) return false;
  const texts = new Set(walkAxNodes(node).flatMap((candidate) => {
    const text = axNodeText(candidate);
    return text ? [normalizeText(text)] : [];
  }));
  return [...SIGN_OUT_TITLES].some((title) => texts.has(title))
    && [...SWITCH_ACCOUNT_TITLES].some((title) => texts.has(title));
}
```

Do not alter `hasStateUrl`, `LOGIN_TITLES`, `CHALLENGE_TITLES`, or the order of login/challenge checks.

- [ ] **Step 3: Run the focused selector test and verify GREEN**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
```

Expected: every test in the selector file passes, including the old `account-panel` case, the `pages` cases, all missing-control cases, and all login/challenge stop-state cases. The approved account-management title variants are `账号管理`, `Account Settings`, and `登陆`.

- [ ] **Step 4: Run collector regression tests and type checking**

Run:

```bash
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
```

Expected: all commands exit successfully with no new warnings or formatting errors.

- [ ] **Step 5: Commit the focused repair**

```bash
git add apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts
git commit -m "fix: accept logged-in Taobao loginPop frame"
```

#### Runtime Evidence Addendum: Task 2 Fix Round 1

After the Task 2 path repair passed its focused and full verification, three consecutive live AX snapshots showed the same logged-in frame: `AXWebArea`, `file:`, terminal `pages/loginPop/index.html` path, title `登陆`, and both `退出登录` and `切换账号` controls. The user approved `登陆` only under the unchanged complete evidence gate. Add the positive and missing-control regressions first, observe only the positive case fail with `LoginRequiredError`, then make the minimal production change by adding `登陆` to `ACCOUNT_MANAGEMENT_TITLES`.

---

### Task 3: Verify the Real Desktop Runtime Before Collection

**Files:**
- No tracked file changes.
- Uses ignored local configuration: `.env`, `.env.collector`, and the collector work directory.

**Interfaces:**
- API health: `GET http://127.0.0.1:4101/api/health`.
- Collector diagnostic: `pnpm collector:diagnose`.

- [ ] **Step 1: Confirm local infrastructure and Taobao Desktop are ready**

Verify Docker Desktop, PostgreSQL, Redis, and Taobao Desktop `2.4.5` build `15` are running. Keep the Taobao account logged in and leave any manual challenge untouched.

- [ ] **Step 2: Start the real API on loopback port 4101**

In a dedicated terminal from the worktree, run:

```bash
DOTENV_CONFIG_PATH="$PWD/.env" API_PORT=4101 PUBLIC_BASE_URL=http://127.0.0.1:4101 pnpm dev:api
```

In another terminal, verify:

```bash
curl --fail --silent http://127.0.0.1:4101/api/health
```

Expected: the API reports healthy database, Redis, queue, collector-agent, and assembled runtime status. Do not paste secret-bearing environment output into logs or chat.

- [ ] **Step 3: Rerun the real collector diagnostic**

Run:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:diagnose
```

Expected: the command ends with `diagnose_complete`. If it returns login, challenge, UI-contract, or permission failure, stop and inspect that exact state; do not bypass it and do not enqueue a collection.

- [ ] **Step 4: Record verification evidence**

Record only non-secret evidence in the completion note:

- focused selector test result;
- full collector test result;
- collector typecheck result;
- API health status;
- exact diagnostic terminal state.

---

### Task 4: Run the Supervised Three-Position Pilot

**Files:**
- No tracked file changes.
- Reuses the local RME Babyface pilot catalog entry and ignored collector evidence directory.

**Interfaces:**
- Admin UI enqueue request with `searchLimit = 3`.
- One-shot worker: `pnpm collector:once`.

- [ ] **Step 1: Gate the pilot on successful diagnostics**

Proceed only when Task 3 ended with `diagnose_complete`. Confirm the enabled pilot is the operator-approved `RME Babyface` model and its run limit is exactly `3`, not the scheduled limit of `50`.

- [ ] **Step 2: Enqueue the pilot from the real local admin UI**

Create one run for the RME Babyface pilot with `searchLimit = 3`. Confirm the returned run ID belongs to that pilot and is queued once; do not enqueue a duplicate run.

- [ ] **Step 3: Run one supervised collection**

With the operator watching Taobao Desktop, run:

```bash
COLLECTOR_API_URL=http://127.0.0.1:4101 pnpm collector:once
```

Stop immediately on login loss, platform challenge, changed page structure, changed item identity, or repeated no-progress state. Never automate or bypass a verification prompt.

- [ ] **Step 4: Review the result before any external action**

Verify the terminal report preserves the first three displayed ranks in order, including duplicate or sponsored positions; identifies each shop, item link, displayed price, every accessible SKU combination, activity price, stock, promotions, and evidence; and separates lower-price comparisons from missing own SKU combinations.

Do not send an Enterprise WeChat message and do not change any store price in this pilot. Report the run ID and any blocked or review-required SKU evidence to the operator.
