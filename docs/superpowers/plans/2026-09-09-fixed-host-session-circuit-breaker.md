# Fixed-Host Collector Session Circuit Breaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current Mac the only Taobao collection host and ensure one expired Taobao session produces one paused workflow and one Enterprise WeChat incident instead of repeatedly opening login flows for later models.

**Architecture:** The macOS collector passively observes Taobao Desktop before every claim and sends a strict session observation with the claim request. The API persists that observation, enforces one active workflow per collector agent, resumes the oldest paused checkpoint only after a `READY` observation, and records one durable notification incident per blocked episode. The existing Taobao Desktop SKU driver remains unchanged as the price collection surface.

**Tech Stack:** TypeScript 7, Node.js 22+, Zod 4, NestJS, Prisma 7/PostgreSQL, React 19, Ant Design, Node test runner, existing macOS accessibility helper.

## Global Constraints

- Only the current Mac keeps the collector pairing token and runs `collector:worker`; the other Mac and Windows computer are dashboard-only.
- Taobao Desktop remains fixed at version `2.4.5`, build `15` for this collector profile.
- Session states are exactly `READY`, `LOGIN_REQUIRED`, `CHALLENGE_REQUIRED`, and `UNAVAILABLE`; only `READY` may claim or resume work.
- One collector agent may own at most one non-stale active workflow at a time.
- A paused run keeps its existing checkpoint; recovery resumes the oldest owned paused run before any new queued run.
- Repeated observations within one blocked episode create at most one Enterprise WeChat incident.
- Do not store or extract cookies, passwords, QR payloads, authorization headers, or raw login-page content.
- Do not automate login, CAPTCHA, platform challenges, repricing, or coordinate clicks.
- Preserve all pre-existing uncommitted work; every staged diff must be inspected before commit.
- Do not run the full API integration suite against the default `public` schema. Run only named, prefix-cleaning integration specs or an isolated test schema.

---

### Task 1: Shared Session Observation and Passive macOS Probe

**Files:**
- Modify: `packages/contracts/src/desktop-collector.ts`
- Modify: `packages/contracts/src/desktop-collector.test.ts`
- Create: `apps/collector/src/agent/taobao-session-observer.ts`
- Create: `apps/collector/src/agent/taobao-session-observer.spec.ts`
- Modify: `apps/collector/src/agent/collector-worker.ts`
- Modify: `apps/collector/src/agent/collector-worker.spec.ts`
- Modify: `apps/collector/src/agent/collector-api-client.ts`
- Modify: `apps/collector/src/agent/collector-api-client.spec.ts`
- Modify: `apps/collector/src/main.ts`
- Modify: `apps/collector/src/main.spec.ts`

**Interfaces:**
- Produces: `collectorSessionStateSchema`, `collectorSessionObservationSchema`, `collectorClaimInputSchema`, `CollectorSessionState`, `CollectorSessionObservation`, and `CollectorClaimInput` from `@stau-price-monitor/contracts`.
- Produces: `TaobaoSessionObserver.observe(): Promise<CollectorSessionObservation>` and `TaobaoSessionObserver.close(): void`.
- Changes: `CollectorWorkerApi.claim(input: CollectorClaimInput): Promise<CollectorJob | null>`.
- Consumes: existing `AxHelperClient`, `assertNoStopState`, `hasDesktopAccountLogin`, `LoginRequiredError`, and `PlatformChallengeError`.

- [ ] **Step 1: Write failing shared-contract tests**

Add literal acceptance and rejection cases:

```ts
assert.deepEqual(collectorClaimInputSchema.parse({
  appVersion: "2.4.5",
  capabilities: ["accessibility", "all-sku", "png-evidence"],
  session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
}), {
  appVersion: "2.4.5",
  capabilities: ["accessibility", "all-sku", "png-evidence"],
  session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
});

for (const state of ["READY", "LOGIN_REQUIRED", "CHALLENGE_REQUIRED", "UNAVAILABLE"]) {
  assert.equal(collectorSessionStateSchema.parse(state), state);
}

assert.equal(collectorClaimInputSchema.safeParse({
  appVersion: "2.4.5",
  capabilities: [],
  session: { state: "LOGGED_OUT", observedAt: "2026-09-09T01:30:00.000Z" }
}).success, false);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
pnpm test:contracts
```

Expected: FAIL because the session schemas and exported types do not exist.

- [ ] **Step 3: Add the strict shared schemas**

Add the production contract:

```ts
export const COLLECTOR_SESSION_STATES = [
  "READY", "LOGIN_REQUIRED", "CHALLENGE_REQUIRED", "UNAVAILABLE"
] as const;

export const collectorSessionStateSchema = z.enum(COLLECTOR_SESSION_STATES);
export const collectorSessionObservationSchema = z.object({
  state: collectorSessionStateSchema,
  observedAt: timestampSchema
}).strict();

export const collectorClaimInputSchema = z.object({
  appVersion: z.string().trim().min(1).max(120),
  capabilities: z.array(z.string().trim().min(1).max(120)),
  session: collectorSessionObservationSchema
}).strict();

export type CollectorSessionState = z.infer<typeof collectorSessionStateSchema>;
export type CollectorSessionObservation = z.infer<typeof collectorSessionObservationSchema>;
export type CollectorClaimInput = z.infer<typeof collectorClaimInputSchema>;
```

- [ ] **Step 4: Write failing passive-observer tests**

Use a fake AX client that records commands. Cover ready, login, challenge, and unavailable states. The ready case must assert the exact side-effect boundary:

```ts
const observation = await observer.observe();
assert.equal(observation.state, "READY");
assert.deepEqual(client.commands, ["diagnose", "snapshot"]);
assert.equal(client.commands.includes("activate"), false);
```

The login case uses an existing strict login fixture and expects `LOGIN_REQUIRED`; the challenge case expects `CHALLENGE_REQUIRED`; missing app, permissions, supported window, or a safe snapshot expects `UNAVAILABLE`.

- [ ] **Step 5: Run the observer test and verify RED**

Run:

```bash
node --test apps/collector/src/agent/taobao-session-observer.spec.ts
```

Expected: FAIL because `taobao-session-observer.ts` does not exist.

- [ ] **Step 6: Implement the passive observer**

Implement the state classifier without `activate`:

```ts
export class TaobaoSessionObserver {
  constructor(
    private readonly client: Pick<AxHelperClient, "diagnose" | "snapshot" | "close">,
    private readonly capturedAt: () => string = () => new Date().toISOString()
  ) {}

  async observe(): Promise<CollectorSessionObservation> {
    try {
      const diagnostic = await this.client.diagnose();
      if (!diagnostic.appInstalled || !diagnostic.appRunning || !diagnostic.trusted
        || !diagnostic.screenRecordingTrusted || !diagnostic.frontWindowAvailable
        || diagnostic.shortVersion !== "2.4.5" || diagnostic.build !== "15") {
        return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
      }
      const root = await this.client.snapshot();
      try {
        assertNoStopState(root);
        return {
          state: hasDesktopAccountLogin(root) ? "LOGIN_REQUIRED" : "READY",
          observedAt: this.capturedAt()
        };
      } catch (error) {
        if (error instanceof LoginRequiredError) {
          return { state: "LOGIN_REQUIRED", observedAt: this.capturedAt() };
        }
        if (error instanceof PlatformChallengeError) {
          return { state: "CHALLENGE_REQUIRED", observedAt: this.capturedAt() };
        }
        return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
      }
    } catch {
      return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
    }
  }

  close(): void {
    this.client.close();
  }
}
```

- [ ] **Step 7: Write failing worker and API-client tests**

Change the fake API to capture the claim body and assert that an observation is made before the claim:

```ts
assert.deepEqual(api.claimInputs, [{
  appVersion: "2.4.5",
  capabilities: ["accessibility", "png-evidence"],
  session: { state: "LOGIN_REQUIRED", observedAt: "2026-09-09T01:30:00.000Z" }
}]);
assert.equal(runnerCalls, 0);
```

Also verify that the client serializes `session` exactly and rejects malformed observation input before making a request.

- [ ] **Step 8: Run focused worker and client tests and verify RED**

Run:

```bash
node --test apps/collector/src/agent/collector-worker.spec.ts apps/collector/src/agent/collector-api-client.spec.ts
```

Expected: FAIL because claim inputs do not yet carry `session`.

- [ ] **Step 9: Wire the observer through the worker and collector entrypoint**

Add `sessionObserver` to `CollectorWorkerOptions`, observe before each claim, validate with the shared schema, and pass the result to the API. Construct one long-lived `TaobaoSessionObserver` in `defaultCreateWorker`; close it when the worker stops. A non-ready observation is still sent to the API so the server can persist the blocked state, but the collector never creates a runner unless the API returns a job.

Use the shared schema in `CollectorApiClient`:

```ts
async claim(input: CollectorClaimInput): Promise<CollectorJob | null> {
  const body = validatedInput(collectorClaimInputSchema, input, "POST", route);
  // existing request and response handling remains unchanged
}
```

- [ ] **Step 10: Run focused tests and verify GREEN**

Run:

```bash
pnpm test:contracts
node --test apps/collector/src/agent/taobao-session-observer.spec.ts apps/collector/src/agent/collector-worker.spec.ts apps/collector/src/agent/collector-api-client.spec.ts apps/collector/src/main.spec.ts
```

Expected: all selected tests PASS.

- [ ] **Step 11: Commit Task 1**

Inspect `git diff --cached` before committing. Do not stage unrelated pre-existing changes.

```bash
git commit -m "feat(collector): observe Taobao session before claims"
```

---

### Task 2: Durable Agent Gate, Single-Workflow Claiming, and Automatic Recovery

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260909093000_add_collector_session_gate/migration.sql`
- Modify: `apps/api/src/http/collector-agent-http.controller.ts`
- Modify: `apps/api/src/http/collector-agent-http.controller.spec.ts`
- Modify: `apps/api/src/collector-agent/collector-agent.service.ts`
- Modify: `apps/api/src/collector-agent/collector-agent.service.spec.ts`
- Modify: `apps/api/src/collector-agent/prisma-collector-agent.repository.ts`
- Modify: `apps/api/src/collector-agent/prisma-collector-agent-recovery.integration.spec.ts`
- Modify: `apps/api/src/collection/collection-run-queue.service.ts`
- Modify: `apps/api/src/collection/collection-run-queue.service.spec.ts`

**Interfaces:**
- Consumes: `CollectorClaimInput` and `CollectorSessionState` from Task 1.
- Changes: `CollectorAgentRepository.claimNext(agentId, input: CollectorClaimInput)`.
- Produces: persisted `CollectorAgent.sessionState`, `sessionObservedAt`, and `sessionChangedAt`.
- Preserves: `CollectorJob | null` as the external claim response.

- [ ] **Step 1: Write failing service and controller contract tests**

Assert the controller accepts the exact shared claim body and rejects missing, stale-shaped, or extra session fields. Assert the service forwards the complete observation unchanged:

```ts
assert.deepEqual(repository.claimInputs, [{
  agentId: "agent-1",
  input: {
    appVersion: "2.4.5",
    capabilities: ["accessibility", "all-sku", "png-evidence"],
    session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
  }
}]);
```

- [ ] **Step 2: Run focused API unit tests and verify RED**

Run:

```bash
node --test apps/api/src/http/collector-agent-http.controller.spec.ts apps/api/src/collector-agent/collector-agent.service.spec.ts
```

Expected: FAIL because the API still accepts only app version and capabilities.

- [ ] **Step 3: Add Prisma session state and migration**

Add:

```prisma
enum CollectorSessionState {
  READY
  LOGIN_REQUIRED
  CHALLENGE_REQUIRED
  UNAVAILABLE
}

model CollectorAgent {
  // existing fields remain
  sessionState       CollectorSessionState @default(UNAVAILABLE)
  sessionObservedAt  DateTime?
  sessionChangedAt   DateTime?
}
```

The migration creates the enum and the three columns without modifying existing runs. Existing agents start `UNAVAILABLE` and cannot claim until their current collector reports a fresh observation.

- [ ] **Step 4: Write failing repository integration cases**

Extend the prefix-cleaning recovery spec with literal scenarios:

```ts
const blocked = await repository.claimNext(ownerId, {
  ...capabilities,
  session: { state: "LOGIN_REQUIRED", observedAt: now.toISOString() }
});
assert.equal(blocked, null);
assert.equal(await prisma.collectionRun.count({ where: { status: "RUNNING" } }), 0);
```

Add cases proving:

1. Two concurrent ready claims with the same agent return exactly one job.
2. A non-stale owned `RUNNING` run blocks another queued run.
3. A blocked observation leaves queued runs untouched.
4. A ready observation resumes the oldest owned `PAUSED_LOGIN` run and clears its pause error.
5. A ready observation resumes `PAUSED_CHALLENGE` only after the observer reports ready.
6. A stale owned `RUNNING` checkpoint is reclaimed before paused or queued work.

- [ ] **Step 5: Apply the migration to an isolated or backed-up development database and verify RED**

Run the new migration, regenerate Prisma, then run only the named prefix-cleaning integration spec:

```bash
pnpm db:generate
node --test --test-concurrency=1 apps/api/src/collector-agent/prisma-collector-agent-recovery.integration.spec.ts
```

Expected: the new behavioral cases FAIL because claim serialization and recovery are not implemented.

- [ ] **Step 6: Implement serialized claim gating and recovery**

Inside the existing serializable transaction:

```ts
const observationChanged = agent.sessionState !== input.session.state;
await transaction.collectorAgent.update({
  where: { id: agentId },
  data: {
    appVersion: input.appVersion,
    capabilities: input.capabilities,
    lastSeenAt: now,
    sessionState: input.session.state,
    sessionObservedAt: new Date(input.session.observedAt),
    ...(observationChanged ? { sessionChangedAt: now } : {})
  }
});

if (input.session.state !== "READY") return null;
```

Then enforce this exact order:

1. Reclaim one stale owned `RUNNING` run under the existing lease guard.
2. Return no job when any non-stale owned `RUNNING` run exists.
3. Atomically move the oldest owned paused run to `RUNNING`, clear its pause error, and preserve `claimedJob` and checkpoint ownership.
4. Claim the oldest eligible queued run only when none of the above exists.

Change `pause` to one serializable transaction that updates the run and the owning agent to `LOGIN_REQUIRED` or `CHALLENGE_REQUIRED`. Update admin requeue so it refuses to requeue while the owning collector session is not `READY`; this prevents a button click from reopening the same login page.

- [ ] **Step 7: Run focused API tests and verify GREEN**

Run:

```bash
node --test apps/api/src/http/collector-agent-http.controller.spec.ts apps/api/src/collector-agent/collector-agent.service.spec.ts apps/api/src/collection/collection-run-queue.service.spec.ts
node --test --test-concurrency=1 apps/api/src/collector-agent/prisma-collector-agent-recovery.integration.spec.ts
```

Expected: all selected tests PASS and test-created rows are removed by their prefix cleanup.

- [ ] **Step 8: Commit Task 2**

```bash
git commit -m "feat(api): gate collection by agent session"
```

---

### Task 3: One Durable Enterprise WeChat Incident per Blocked Episode

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260909113000_add_collector_session_incident/migration.sql`
- Create: `apps/api/src/collector-agent/collector-session-incident.repository.ts`
- Create: `apps/api/src/collector-agent/collector-session-incident.repository.spec.ts`
- Create: `apps/api/src/collector-agent/collector-session-notifier.ts`
- Create: `apps/api/src/collector-agent/collector-session-notifier.spec.ts`
- Create: `apps/api/src/alerts/wecom/wecom-collector-session.ts`
- Create: `apps/api/src/alerts/wecom/wecom-collector-session.spec.ts`
- Modify: `apps/api/src/collector-agent/collector-agent.service.ts`
- Modify: `apps/api/src/collector-agent/collector-agent.service.spec.ts`
- Modify: `apps/api/src/runtime.ts`

**Interfaces:**
- Consumes: agent session transitions from Task 2, `WecomClient`, and `SettingsService.isWecomLiveSendingApproved()`.
- Produces: `CollectorSessionIncidentNotifier.notifyPending(agentId: string): Promise<void>`.
- Produces: one unresolved incident per collector agent and terminal notification states compatible with the existing WeCom ambiguity rules.

- [ ] **Step 1: Write failing message-builder tests**

Assert the exact sanitized content fields and the absence of secrets:

```ts
const markdown = buildWecomCollectorSessionMessage({
  agentName: "固定采集 Mac",
  state: "LOGIN_REQUIRED",
  openedAt: "2026-09-09T01:30:00.000Z"
}).markdown.content;

assert.match(markdown, /淘宝采集已暂停/);
assert.match(markdown, /固定采集 Mac/);
assert.match(markdown, /请只在固定 Mac 上恢复一次淘宝登录/);
assert.equal(/cookie|token|authorization|webhook|二维码/i.test(markdown), false);
```

- [ ] **Step 2: Run the message test and verify RED**

Run:

```bash
node --test apps/api/src/alerts/wecom/wecom-collector-session.spec.ts
```

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Add the incident model and migration**

Add one durable blocked episode:

```prisma
model CollectorSessionIncident {
  id                   String                    @id @default(cuid())
  collectorAgentId     String
  state                CollectorSessionState
  activeKey            String?                   @unique @db.VarChar(200)
  openedAt             DateTime                  @default(now())
  recoveredAt          DateTime?
  notificationState    RunAlertNotificationState @default(PENDING)
  notificationAttempts Int                       @default(0)
  notifiedAt           DateTime?
  lastNotificationError String?                  @db.VarChar(120)
  collectorAgent       CollectorAgent            @relation(fields: [collectorAgentId], references: [id], onDelete: Cascade)

  @@index([collectorAgentId, openedAt])
  @@index([notificationState, openedAt])
}
```

Add `sessionIncidents CollectorSessionIncident[]` to `CollectorAgent`. Use the collector agent ID itself as `activeKey`; set it to `null` on recovery. This enforces one unresolved incident per agent without a nullable partial index.

- [ ] **Step 4: Write failing repository and notifier tests**

Test real repository state transitions through a controlled repository fake and notifier behavior through a fake sender:

```ts
await repository.observeBlocked("agent-1", "LOGIN_REQUIRED", openedAt);
await repository.observeBlocked("agent-1", "LOGIN_REQUIRED", laterAt);
assert.equal(repository.incidents.length, 1);

await notifier.notifyPending("agent-1");
await notifier.notifyPending("agent-1");
assert.equal(sender.messages.length, 1);
assert.equal(repository.incidents[0]?.notificationState, "NOTIFIED");
```

Cover `WECOM_NOT_CONFIGURED`, live-send approval disabled, explicit send failure with bounded retry, and ambiguous delivery becoming terminal `AMBIGUOUS` without a second POST.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```bash
node --test apps/api/src/collector-agent/collector-session-incident.repository.spec.ts apps/api/src/collector-agent/collector-session-notifier.spec.ts apps/api/src/alerts/wecom/wecom-collector-session.spec.ts
```

Expected: FAIL because the incident repository and notifier do not exist.

- [ ] **Step 6: Implement transition persistence and bounded notification**

Implement idempotent repository methods:

```ts
interface CollectorSessionIncidentRepository {
  observeBlocked(agentId: string, state: "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED", at: Date): Promise<string>;
  observeReady(agentId: string, at: Date): Promise<void>;
  claimPending(agentId: string): Promise<CollectorSessionIncidentDelivery | null>;
  markNotified(id: string, at: Date): Promise<void>;
  markFailure(id: string, code: "WECOM_NOT_CONFIGURED" | "WECOM_DELIVERY_FAILED" | "WECOM_DELIVERY_AMBIGUOUS"): Promise<void>;
}
```

Use compare-and-set updates from `PENDING` or retryable `FAILED` to `SENDING`. Follow the existing run-alert policy: explicit rejected responses may retry up to the established maximum; an ambiguous POST result is terminal and is never sent again.

Invoke `observeBlocked` when Task 2 records a blocked transition and call `notifyPending` after the transaction commits. Invoke `observeReady` on the ready transition. Notification errors are recorded and swallowed at the service boundary so they cannot authorize a claim or crash the collector loop.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
node --test apps/api/src/collector-agent/collector-session-incident.repository.spec.ts apps/api/src/collector-agent/collector-session-notifier.spec.ts apps/api/src/alerts/wecom/wecom-collector-session.spec.ts apps/api/src/collector-agent/collector-agent.service.spec.ts
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git commit -m "feat(alerts): notify once for collector session loss"
```

---

### Task 4: Operations Visibility and Automatic-Recovery Copy

**Files:**
- Modify: `apps/api/src/operations/collection-report-query.service.ts`
- Modify: `apps/api/src/operations/collection-report-query.service.spec.ts`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.tsx`
- Modify: `apps/web/src/pages/CollectionRunDetailPage.test.tsx`
- Modify: `docs/operations/collector-recovery.md`
- Modify: `docs/operations/macos-collector.md`
- Modify: `docs/operations/macos-setup.md`

**Interfaces:**
- Extends: `CollectionRunReportSummary.collector` with `sessionState`, `sessionObservedAt`, and `sessionChangedAt`.
- Consumes: persisted agent state from Task 2.
- Preserves: existing run-detail URL and pagination contracts.

- [ ] **Step 1: Write failing API query and UI tests**

Assert the run detail maps exact session fields:

```ts
assert.deepEqual(report.collector, {
  id: "agent-1",
  name: "固定采集 Mac",
  platform: "MACOS",
  appVersion: "2.4.5",
  sessionState: "LOGIN_REQUIRED",
  sessionObservedAt: "2026-09-09T01:30:00.000Z",
  sessionChangedAt: "2026-09-09T01:30:00.000Z"
});
```

Render the paused report and assert the operator-facing behavior:

```tsx
expect(screen.getByText("采集会话：需要登录")).toBeInTheDocument();
expect(screen.getByText(/只需在固定 Mac 上恢复一次淘宝登录/)).toBeInTheDocument();
expect(screen.getByText(/系统确认后会自动续跑/)).toBeInTheDocument();
expect(screen.queryByRole("button", { name: "重新入队" })).not.toBeInTheDocument();
```

Also cover `READY`, `CHALLENGE_REQUIRED`, and `UNAVAILABLE` labels.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test apps/api/src/operations/collection-report-query.service.spec.ts
pnpm --filter @stau-price-monitor/web test -- CollectionRunDetailPage.test.tsx
```

Expected: FAIL because collector session fields and copy do not exist.

- [ ] **Step 3: Expose and render collector session state**

Extend the Prisma select and map nullable timestamps to ISO strings. Add this strict web type:

```ts
sessionState: "READY" | "LOGIN_REQUIRED" | "CHALLENGE_REQUIRED" | "UNAVAILABLE";
sessionObservedAt: string | null;
sessionChangedAt: string | null;
```

Replace the immediate manual-requeue prompt with state-aware copy. A paused run tells the operator to restore login or complete the challenge once on the fixed Mac and explains that the API will resume automatically. Keep error details and historical run data visible.

- [ ] **Step 4: Update fixed-host operating documentation**

Document one startup sequence on the current Mac, dashboard-only use on the other computers, one-login recovery, automatic checkpoint resume, and the rule that a challenge is never bypassed. Remove the old instruction that always requires the administrator to requeue a login-paused run manually.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test apps/api/src/operations/collection-report-query.service.spec.ts
pnpm --filter @stau-price-monitor/web test -- CollectionRunDetailPage.test.tsx
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git commit -m "feat(operations): show collector session gate"
```

---

### Task 5: End-to-End Verification on the Fixed Mac

**Files:**
- Modify only when verification exposes a specific covered defect.

**Interfaces:**
- Consumes: every interface produced by Tasks 1 through 4.
- Produces: verified fixed-host collector behavior and a documented live acceptance result.

- [ ] **Step 1: Run safe automated verification**

Run:

```bash
pnpm test:contracts
pnpm test:collector
pnpm test:api:portable
pnpm test:web
pnpm typecheck
pnpm db:validate
git diff --check
```

Expected: every command exits `0`. Do not run `pnpm test:api` against the default `public` schema.

- [ ] **Step 2: Run the scoped database claim test**

Run only the prefix-cleaning integration spec after confirming the migrated development schema:

```bash
node --test --test-concurrency=1 apps/api/src/collector-agent/prisma-collector-agent-recovery.integration.spec.ts
```

Expected: all cases PASS and no test rows remain.

- [ ] **Step 3: Diagnose the fixed Mac without claiming**

Start API and web services, keep Taobao Desktop open, and run:

```bash
pnpm collector:diagnose
```

Expected: supported app/build, permissions, and session observation complete without claiming a run.

- [ ] **Step 4: Verify the blocked episode with fixtures**

Use the existing strict login fixture and two queued test models. Do not sign the
live Taobao account out solely for this test. Verify:

1. No job is claimed after the passive blocked observation.
2. No Taobao activation or login button action occurs.
3. The API stores one blocked state and one active incident.
4. Repeated worker polls do not create another incident or WeChat POST.
5. The second model remains queued or coalesced and never starts.

- [ ] **Step 5: Verify one-login automatic recovery**

When a real session naturally requires login, manually complete the normal
Taobao login once on the fixed Mac. Verify the next passive observation becomes
`READY`, the oldest paused run returns to `RUNNING`, its checkpoint remains
intact, and later queued work stays serialized. If no natural expiry occurs
during acceptance, record this live case as pending instead of forcing a logout.

- [ ] **Step 6: Verify one real `RME Babyface` pilot**

Run the enabled `RME Babyface` model with `searchLimit: 50`. Confirm the report records the own listing, first 50 competitor positions or a verified end marker, every accessible SKU, activity-price evidence, and no additional login prompt during the run.

- [ ] **Step 7: Record verification and commit only evidence-backed adjustments**

If no code adjustment is needed, do not create a filler commit. If verification exposes a defect, write a failing test, verify RED, implement the smallest correction, verify GREEN, and commit:

```bash
git commit -m "fix(collector): complete fixed-host session acceptance"
```
