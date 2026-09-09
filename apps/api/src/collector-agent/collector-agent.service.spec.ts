import assert from "node:assert/strict";
import test from "node:test";

import type {
  CollectorClaimInput,
  CollectorJob
} from "../../../../packages/contracts/src/index.ts";

import {
  CollectorAgentAuthenticationError,
  CollectorAgentRunOwnershipError,
  CollectorAgentService,
  type CollectorAgentRepository
} from "./collector-agent.service.ts";
import { verifyCollectorToken } from "./collector-token.ts";

interface AgentRecord {
  id: string;
  name: string;
  platform: "MACOS" | "WINDOWS";
  tokenHash: string;
  enabled: boolean;
}

interface RunRecord {
  id: string;
  status: "QUEUED" | "RUNNING" | "PAUSED_LOGIN" | "PAUSED_CHALLENGE" | "FAILED";
  collectorAgentId: string | null;
  scheduledFor: number;
  discoveredCount: number;
  skuCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  heartbeatAt: number;
}

const modelJob = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-placeholder",
  monitoredModelId: "model-1",
  searchQuery: "Sony MDR-7506",
  searchLimit: 50,
  ownShopName: "Own Shop",
  ownListings: [
    { id: "own-active-1", url: "https://detail.tmall.com/item.htm?id=1", skuText: "MDR-7506 black" },
    { id: "own-active-2", url: "https://detail.tmall.com/item.htm?id=2", skuText: "MDR-7506 blue" }
  ],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    colorComparable: false,
    effectiveAliases: ["7506"],
    excludedAliases: ["M1", "MV1"],
    mustIncludeTerms: ["7506"],
    excludedTerms: ["used"]
  }
} satisfies CollectorJob;

const readyClaimInput: CollectorClaimInput = {
  appVersion: "2.4.5",
  capabilities: ["accessibility"],
  session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
};

class InMemoryCollectorAgentRepository implements CollectorAgentRepository {
  readonly agents: AgentRecord[] = [];
  readonly runs: RunRecord[] = [];
  lastRegistrationActorId: string | null = null;
  readonly claimInputs: Array<{ agentId: string; input: CollectorClaimInput }> = [];
  private nextAgentId = 1;

  addAgent(input: Omit<AgentRecord, "id"> & { id?: string }): AgentRecord {
    const agent = { ...input, id: input.id ?? `agent-${this.nextAgentId++}` };
    this.agents.push(agent);
    return agent;
  }

  addRun(input: Partial<RunRecord> & Pick<RunRecord, "id">): RunRecord {
    const run: RunRecord = {
      id: input.id,
      status: input.status ?? "QUEUED",
      collectorAgentId: input.collectorAgentId ?? null,
      scheduledFor: input.scheduledFor ?? this.runs.length,
      discoveredCount: input.discoveredCount ?? 0,
      skuCount: input.skuCount ?? 0,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      heartbeatAt: input.heartbeatAt ?? Date.now()
    };
    this.runs.push(run);
    return run;
  }

  requeue(runId: string): void {
    const run = this.runs.find((entry) => entry.id === runId);
    if (run) run.status = "QUEUED";
  }

  async createAgent(input: {
    name: string;
    platform: "MACOS" | "WINDOWS";
    tokenHash: string;
    actorId: string;
  }): Promise<{ id: string; name: string }> {
    this.lastRegistrationActorId = input.actorId;
    return this.addAgent({
      name: input.name,
      platform: input.platform,
      tokenHash: input.tokenHash,
      enabled: true
    });
  }

  async authenticate(token: string): Promise<{ id: string; enabled: boolean } | null> {
    const agent = this.agents.find((entry) => verifyCollectorToken(token, entry.tokenHash));
    return agent ? { id: agent.id, enabled: agent.enabled } : null;
  }

  async claimNext(
    agentId: string,
    input: CollectorClaimInput
  ): Promise<CollectorJob | null> {
    this.claimInputs.push({ agentId, input });
    const run = this.runs
      .filter((entry) => entry.status === "QUEUED"
        && (entry.collectorAgentId === null || entry.collectorAgentId === agentId))
      .sort((left, right) => left.scheduledFor - right.scheduledFor)[0];
    if (!run) return null;

    run.status = "RUNNING";
    run.collectorAgentId = agentId;
    return { ...modelJob, runId: run.id, collectorId: agentId };
  }

  async heartbeat(
    agentId: string,
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<boolean> {
    const run = this.runs.find((entry) => entry.id === runId
      && entry.status === "RUNNING" && entry.collectorAgentId === agentId);
    if (!run) return false;
    run.discoveredCount = input.discoveredCount;
    run.skuCount = input.skuCount;
    return true;
  }

  async pause(
    agentId: string,
    runId: string,
    status: "PAUSED_LOGIN" | "PAUSED_CHALLENGE",
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<boolean> {
    const run = this.runs.find((entry) => entry.id === runId
      && entry.status === "RUNNING" && entry.collectorAgentId === agentId);
    if (!run) return false;
    run.status = status;
    run.errorCode = code;
    run.errorMessage = message;
    return true;
  }

  async release(
    agentId: string,
    runId: string,
    input: { disposition: "REQUEUE" } | { disposition: "QUARANTINE"; errorCode: "INVALID_CHECKPOINT" }
  ): Promise<boolean> {
    const run = this.runs.find((entry) => entry.id === runId
      && entry.status === "RUNNING" && entry.collectorAgentId === agentId);
    if (!run) return false;
    if (input.disposition === "QUARANTINE") {
      run.status = "FAILED";
      run.errorCode = input.errorCode;
      run.errorMessage = "Collector checkpoint requires operator review";
    } else {
      run.status = "QUEUED";
    }
    return true;
  }

  async ownsRun(agentId: string, runId: string): Promise<boolean> {
    return this.runs.some((entry) => entry.id === runId && entry.collectorAgentId === agentId);
  }
}

class RecordingSessionNotifier {
  readonly agentIds: string[] = [];
  failure: Error | null = null;

  async notifyPending(agentId: string): Promise<void> {
    this.agentIds.push(agentId);
    if (this.failure) throw this.failure;
  }
}

async function registerAgent(
  service: CollectorAgentService,
  name: string,
  platform: "MACOS" | "WINDOWS" = "MACOS"
) {
  return service.register({ name, platform }, "admin-1");
}

test("registration returns plaintext once while the repository receives only a hash", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);

  const registered = await registerAgent(service, "mac-studio-1");
  const stored = repository.agents[0];

  assert.ok(stored);
  assert.match(registered.token, /^pmc_[A-Za-z0-9_-]{43}$/);
  assert.match(stored.tokenHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(stored.tokenHash, registered.token);
  assert.equal(verifyCollectorToken(registered.token, stored.tokenHash), true);
  assert.equal(repository.lastRegistrationActorId, "admin-1");
});

test("disabled agents cannot claim jobs", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const registered = await registerAgent(service, "disabled-mac");
  repository.agents[0]!.enabled = false;
  repository.addRun({ id: "run-disabled" });

  await assert.rejects(
    () => service.claimNext(registered.token, { ...readyClaimInput, capabilities: ["macos"] }),
    CollectorAgentAuthenticationError
  );
  assert.equal(repository.runs[0]!.status, "QUEUED");
});

test("assertAuthenticated validates credentials without claiming or updating a run", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const registered = await registerAgent(service, "authentication-only-mac");
  const run = repository.addRun({ id: "run-authentication-only" });

  await service.assertAuthenticated(registered.token);
  assert.equal(run.status, "QUEUED");
  await assert.rejects(() => service.assertAuthenticated("invalid"), CollectorAgentAuthenticationError);

  repository.agents[0]!.enabled = false;
  await assert.rejects(
    () => service.assertAuthenticated(registered.token),
    CollectorAgentAuthenticationError
  );
  assert.equal(run.status, "QUEUED");
});

test("concurrent agents cannot claim the same run", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const first = await registerAgent(service, "mac-1");
  const second = await registerAgent(service, "mac-2");
  repository.addRun({ id: "oldest-run", scheduledFor: 1 });

  const claims = await Promise.all([
    service.claimNext(first.token, readyClaimInput),
    service.claimNext(second.token, readyClaimInput)
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.runId, "oldest-run");
});

test("claimed jobs contain the model rule and every active own listing", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const registered = await registerAgent(service, "mac-job-shape");
  repository.addRun({ id: "run-job-shape" });

  const job = await service.claimNext(registered.token, readyClaimInput);

  assert.equal(job?.rule.standardModel, "MDR-7506");
  assert.equal(job?.rule.colorComparable, false);
  assert.deepEqual(job?.rule.effectiveAliases, ["7506"]);
  assert.deepEqual(job?.ownListings.map((listing) => listing.id), ["own-active-1", "own-active-2"]);
  assert.equal(job?.collectorId, repository.agents[0]?.id);
  assert.deepEqual(repository.claimInputs, [{
    agentId: repository.agents[0]!.id,
    input: readyClaimInput
  }]);
});

test("a blocked claim triggers notification after the repository transaction", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const notifier = new RecordingSessionNotifier();
  const now = new Date("2026-09-09T01:31:00.000Z");
  const service = new CollectorAgentService(repository, notifier, () => now);
  const registered = await registerAgent(service, "fixed-collector-mac");

  await service.claimNext(registered.token, {
    ...readyClaimInput,
    session: { state: "LOGIN_REQUIRED", observedAt: "2026-09-09T01:30:00.000Z" }
  });
  await service.claimNext(registered.token, readyClaimInput);

  assert.deepEqual(notifier.agentIds, [repository.agents[0]!.id]);
});

test("pausing an active run immediately notifies the atomically recorded blocked episode", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const notifier = new RecordingSessionNotifier();
  const now = new Date("2026-09-09T01:31:00.000Z");
  const service = new CollectorAgentService(repository, notifier, () => now);
  const registered = await registerAgent(service, "fixed-collector-mac-pause");
  repository.addRun({ id: "run-login-loss" });
  await service.claimNext(registered.token, readyClaimInput);

  await service.pause(registered.token, "run-login-loss", "PLATFORM_CHALLENGE", "operator action required");

  assert.deepEqual(notifier.agentIds, [repository.agents[0]!.id]);
});

test("notification failures never break the repository claim result", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const notifier = new RecordingSessionNotifier();
  notifier.failure = new Error("notification unavailable");
  const service = new CollectorAgentService(repository, notifier);
  const registered = await registerAgent(service, "fixed-collector-mac-failure");
  repository.addRun({ id: "run-still-claimed" });

  assert.equal((await service.claimNext(registered.token, {
    ...readyClaimInput,
    session: { state: "LOGIN_REQUIRED", observedAt: "2026-09-09T01:30:00.000Z" }
  }))?.runId, "run-still-claimed");
});

test("heartbeat updates only the owning agent's running job", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const owner = await registerAgent(service, "owner-mac");
  const other = await registerAgent(service, "other-mac");
  const run = repository.addRun({ id: "run-heartbeat" });
  await service.claimNext(owner.token, { ...readyClaimInput, capabilities: [] });

  await assert.rejects(
    () => service.heartbeat(other.token, run.id, { discoveredCount: 4, skuCount: 12 }),
    CollectorAgentRunOwnershipError
  );
  assert.equal(run.discoveredCount, 0);
  assert.equal(run.skuCount, 0);

  await service.heartbeat(owner.token, run.id, { discoveredCount: 4, skuCount: 12 });
  assert.equal(run.discoveredCount, 4);
  assert.equal(run.skuCount, 12);
  assert.deepEqual(await service.assertRunOwnership(owner.token, run.id), {
    agentId: repository.agents[0]!.id,
    runId: run.id
  });
});

test("pause codes map to paused statuses and require explicit requeue", async () => {
  for (const [code, status] of [
    ["LOGIN_REQUIRED", "PAUSED_LOGIN"],
    ["PLATFORM_CHALLENGE", "PAUSED_CHALLENGE"]
  ] as const) {
    const repository = new InMemoryCollectorAgentRepository();
    const service = new CollectorAgentService(repository);
    const registered = await registerAgent(service, `mac-${code.toLowerCase()}`);
    const run = repository.addRun({ id: `run-${code.toLowerCase()}` });
    await service.claimNext(registered.token, { ...readyClaimInput, capabilities: [] });

    await service.pause(registered.token, run.id, code, "operator action required");
    assert.equal(run.status, status);
    assert.equal(run.errorCode, code);
    assert.equal(
      await service.claimNext(registered.token, { ...readyClaimInput, capabilities: [] }),
      null
    );

    repository.requeue(run.id);
    assert.equal(
      (await service.claimNext(registered.token, { ...readyClaimInput, capabilities: [] }))?.runId,
      run.id
    );
  }
});

test("graceful release requeues only the owning agent's running job", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const owner = await registerAgent(service, "owner-release");
  const other = await registerAgent(service, "other-release");
  const run = repository.addRun({ id: "run-release" });
  await service.claimNext(owner.token, { ...readyClaimInput, capabilities: [] });

  await assert.rejects(
    () => service.release(other.token, run.id),
    CollectorAgentRunOwnershipError
  );
  assert.equal(run.status, "RUNNING");

  await service.release(owner.token, run.id);
  assert.equal(run.status, "QUEUED");
  assert.equal(
    (await service.claimNext(owner.token, { ...readyClaimInput, capabilities: [] }))?.runId,
    run.id
  );
});

test("checkpoint quarantine reaches the repository as a terminal release", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const owner = await registerAgent(service, "owner-quarantine");
  const run = repository.addRun({ id: "run-quarantine" });
  await service.claimNext(owner.token, { ...readyClaimInput, capabilities: [] });

  await service.release(owner.token, run.id, {
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  });
  assert.equal(run.status, "FAILED");
  assert.equal(run.errorCode, "INVALID_CHECKPOINT");
});
