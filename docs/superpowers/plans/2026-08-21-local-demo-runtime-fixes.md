# Local Demo Runtime Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented local demo commands load the repository `.env` reliably and allow browser write operations to preserve Chinese operator names without invalid HTTP headers.

**Architecture:** Keep identity handling centralized at the existing web API client and API request-identity boundary. Encode all web actor IDs as an explicitly prefixed URI component, decode only that prefix on the API, and keep legacy ASCII callers unchanged. Use Node.js 22 built-in environment-file loading in API package scripts so pnpm workspace execution does not depend on the current directory behavior of `dotenv/config`.

**Tech Stack:** Node.js 22+, pnpm 11.19.0, TypeScript, React/Vite, NestJS/Express, Vitest, Node test runner, PostgreSQL, Redis.

## Global Constraints

- Preserve Chinese audit actor names such as `本地运营` and `本地管理员`.
- Preserve compatibility with existing unprefixed ASCII `x-actor-id` values.
- Malformed or empty prefixed identities fall back to `local-operator`.
- Do not print `.env` values, secrets, cookies, Webhooks, or authorization headers.
- Do not add dependencies or change the database schema.
- Keep root commands `pnpm dev:api` and `pnpm seed:demo` unchanged.
- Node.js 22, macOS, Windows, and Linux must remain supported.
- Do not implement formal authentication, real Tmall collection, automatic workers, or WeCom sending.

---

### Task 1: Load the root environment file in API commands

**Files:**
- Create: `scripts/api-package-scripts.test.mjs`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: repository root `.env` created by `pnpm setup`.
- Produces: `dev`, `start`, and `seed:demo` package scripts that invoke Node with `--env-file=../../.env` and `--import=tsx` from the `apps/api` working directory.

- [ ] **Step 1: Write the failing package-script contract test**

Create `scripts/api-package-scripts.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const apiPackage = JSON.parse(await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8"));

test("API runtime commands load the repository root env file through Node", () => {
  for (const name of ["dev", "start", "seed:demo"]) {
    const command = apiPackage.scripts[name];
    assert.match(command, /^node /, `${name} must be launched by Node`);
    assert.match(command, /--env-file=\.\.\/\.\.\/\.env(?:\s|$)/, `${name} must load the root .env`);
    assert.match(command, /--import=tsx(?:\s|$)/, `${name} must register tsx`);
  }
  assert.match(apiPackage.scripts.dev, /--watch(?:\s|$)/);
});
```

- [ ] **Step 2: Run the contract test and verify the expected failure**

Run:

```bash
node --test scripts/api-package-scripts.test.mjs
```

Expected: FAIL because the existing commands begin with `tsx` and do not contain `--env-file=../../.env`.

- [ ] **Step 3: Replace the API package commands with Node-built-in env loading**

Change `apps/api/package.json` scripts to:

```json
{
  "dev": "node --env-file=../../.env --import=tsx --watch src/main.ts",
  "start": "node --env-file=../../.env --import=tsx src/main.ts",
  "seed:demo": "node --env-file=../../.env --import=tsx src/database/seed-demo.ts",
  "typecheck": "tsc --noEmit -p tsconfig.json"
}
```

- [ ] **Step 4: Verify the test and documented seed command**

Run:

```bash
node --test scripts/api-package-scripts.test.mjs
pnpm seed:demo
```

Expected: test PASS; seed command exits `0` and reports `Seeded 6 monitored models` without printing environment values.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/api-package-scripts.test.mjs apps/api/package.json
git commit -m "fix: load root env for API commands"
```

---

### Task 2: Safely transport Chinese actor IDs

**Files:**
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/api/src/http/identity.spec.ts`
- Modify: `apps/api/src/http/identity.ts`

**Interfaces:**
- Produces: web header format `uri:<encodeURIComponent(actorId)>`.
- Produces: API function `decodeActorId(rawActor: string | undefined): string`.
- Preserves: unprefixed ASCII actor IDs and existing `requestIdentity(request)` return shape.

- [ ] **Step 1: Add a failing web request test**

Add to `apps/web/src/api/client.test.ts`:

```ts
it("sends a Chinese actor ID as an ASCII-only URI-prefixed header", async () => {
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("x-actor-id")).toBe(`uri:${encodeURIComponent("本地运营")}`);
    expect([...headers.get("x-actor-id") ?? ""].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(apiRequest("/api/alerts/demo/actions", {
    method: "POST",
    actorId: "本地运营",
    body: JSON.stringify({ status: "WATCHING" })
  })).resolves.toEqual({ status: "ok" });
  expect(fetchMock).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Add failing API identity tests**

Create `apps/api/src/http/identity.spec.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";

import { requestIdentity } from "./identity.ts";

function requestWithActor(actorId?: string): Request {
  return {
    headers: actorId === undefined ? {} : { "x-actor-id": actorId }
  } as Request;
}

test("decodes a URI-prefixed Chinese actor ID", () => {
  const encoded = `uri:${encodeURIComponent("本地运营")}`;
  assert.equal(requestIdentity(requestWithActor(encoded)).actorId, "本地运营");
});

test("preserves an unprefixed ASCII actor ID", () => {
  assert.equal(requestIdentity(requestWithActor("operator-9")).actorId, "operator-9");
});

test("falls back for malformed, empty, or missing encoded actor IDs", () => {
  assert.equal(requestIdentity(requestWithActor("uri:%E6%ZZ")).actorId, "local-operator");
  assert.equal(requestIdentity(requestWithActor("uri:")).actorId, "local-operator");
  assert.equal(requestIdentity(requestWithActor()).actorId, "local-operator");
});
```

- [ ] **Step 3: Run both focused suites and verify the expected failures**

Run:

```bash
pnpm --filter @stau-price-monitor/web exec vitest run src/api/client.test.ts
node --test apps/api/src/http/identity.spec.ts
```

Expected: web test FAIL at the non-ASCII `Headers.set`; API decode test FAIL because the prefixed value is returned unchanged.

- [ ] **Step 4: Encode actor IDs in the web API client**

In `apps/web/src/api/client.ts`, replace the actor header assignment with:

```ts
const actorId = options.actorId ?? "local-operator";
headers.set("x-actor-id", `uri:${encodeURIComponent(actorId)}`);
```

- [ ] **Step 5: Decode prefixed actor IDs at the API boundary**

In `apps/api/src/http/identity.ts`, add and use:

```ts
const URI_ACTOR_PREFIX = "uri:";

export function decodeActorId(rawActor: string | undefined): string {
  const value = rawActor?.trim();
  if (!value) {
    return "local-operator";
  }
  if (!value.startsWith(URI_ACTOR_PREFIX)) {
    return value;
  }
  try {
    return decodeURIComponent(value.slice(URI_ACTOR_PREFIX.length)).trim() || "local-operator";
  } catch {
    return "local-operator";
  }
}
```

Then pass the normalized scalar header value to `decodeActorId` from `requestIdentity`.

- [ ] **Step 6: Run focused tests and the complete web/API portable suites**

Run:

```bash
pnpm --filter @stau-price-monitor/web exec vitest run src/api/client.test.ts
node --test apps/api/src/http/identity.spec.ts
pnpm test:api:portable
pnpm test:web
```

Expected: all tests PASS and no browser header exception is emitted.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/web/src/api/client.test.ts apps/web/src/api/client.ts apps/api/src/http/identity.spec.ts apps/api/src/http/identity.ts
git commit -m "fix: encode local actor identity headers"
```

---

### Task 3: End-to-end verification and public release sync

**Files:**
- Verify: all tracked source files
- Update: the sibling public checkout named `price-monitor` to the final source tree
- Regenerate: the external release archive `比价工具_跨平台公开版_2026-08-19.zip`

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: a browser-verified local workflow, a clean public `main`, a matching ZIP archive, and a successful four-job GitHub Actions run.

- [ ] **Step 1: Run every local release gate**

Run:

```bash
node --test scripts/*.test.mjs
pnpm verify:portable
pnpm audit:public
git diff --check
git status --short --branch
```

Expected: all tests, typechecks, build, and public audit PASS; only the known Vite chunk-size warning remains; source status is clean after the two task commits.

- [ ] **Step 2: Restart the API with the fixed command**

Confirm the listener on `127.0.0.1:4100` belongs to this project, stop that development process, then run:

```bash
pnpm dev:api
```

Expected: API starts on `127.0.0.1:4100`; `/api/health` reports database and Redis `up`.

- [ ] **Step 3: Re-run the browser write workflow**

In the existing local browser app:

1. Open a pending alert.
2. Select `继续观察`.
3. Enter `演示：中文操作员请求头修复验证。`.
4. Click `确认处理`.
5. Verify the success message, refreshed status, and absence of the `non ISO-8859-1 code point` error.

Expected: the UI itself completes the write; no curl workaround is used.

- [ ] **Step 4: Verify the persisted Chinese audit actor**

Query the alert action endpoint or PostgreSQL through an existing repository/API surface and assert the newest action uses `本地运营`, not the encoded header value.

- [ ] **Step 5: Synchronize the clean public repository**

Copy only the source repository's Git-tracked final tree into the sibling `price-monitor` public checkout, preserve its one-commit `main` history, run `pnpm audit:public`, and confirm both repositories have the same tree hash.

- [ ] **Step 6: Amend and push the sanitized public root commit**

Use the GitHub noreply identity, amend the existing public root commit, and push with an exact `--force-with-lease` value for the current remote `main`.

Expected: public repository still has exactly one commit; author and committer use `302751370+liuxinpian304-bit@users.noreply.github.com`.

- [ ] **Step 7: Regenerate and verify the release archive**

Run `git archive` from the final public commit, overwrite the existing ZIP, test it with `unzip -tq`, and verify a fresh temporary archive is byte-for-byte identical.

- [ ] **Step 8: Wait for GitHub Actions**

Expected successful jobs:

```text
Portable (ubuntu-latest)
Portable (macos-latest)
Portable (windows-latest)
Linux integration
```

- [ ] **Step 9: Final review**

Review the final public tree for regression risk, actor-header compatibility, environment-value leakage, publication hygiene, and documentation accuracy. Resolve every blocker before reporting completion.
