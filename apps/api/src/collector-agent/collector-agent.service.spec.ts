import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorJob } from "../../../../packages/contracts/src/index.ts";

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
  status: "QUEUED" | "RUNNING" | "PAUSED_LOGIN" | "PAUSED_CHALLENGE";
  collectorAgentId: string | null;
  scheduledFor: number;
  discoveredCount: number;
  skuCount: number;
  errorCode: string | null;
  errorMessage: string | null;
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
    effectiveAliases: ["7506"],
    excludedAliases: ["M1", "MV1"],
    mustIncludeTerms: ["7506"],
    excludedTerms: ["used"]
  }
} satisfies CollectorJob;

class InMemoryCollectorAgentRepository implements CollectorAgentRepository {
  readonly agents: AgentRecord[] = [];
  readonly runs: RunRecord[] = [];
  lastRegistrationActorId: string | null = null;
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
      errorMessage: input.errorMessage ?? null
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
    _input: { appVersion: string; capabilities: string[] }
  ): Promise<CollectorJob | null> {
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

  async ownsRun(agentId: string, runId: string): Promise<boolean> {
    return this.runs.some((entry) => entry.id === runId && entry.collectorAgentId === agentId);
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
    () => service.claimNext(registered.token, { appVersion: "2.4.5", capabilities: ["macos"] }),
    CollectorAgentAuthenticationError
  );
  assert.equal(repository.runs[0]!.status, "QUEUED");
});

test("concurrent agents cannot claim the same run", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const first = await registerAgent(service, "mac-1");
  const second = await registerAgent(service, "mac-2");
  repository.addRun({ id: "oldest-run", scheduledFor: 1 });

  const claims = await Promise.all([
    service.claimNext(first.token, { appVersion: "2.4.5", capabilities: ["accessibility"] }),
    service.claimNext(second.token, { appVersion: "2.4.5", capabilities: ["accessibility"] })
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.runId, "oldest-run");
});

test("claimed jobs contain the model rule and every active own listing", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const registered = await registerAgent(service, "mac-job-shape");
  repository.addRun({ id: "run-job-shape" });

  const job = await service.claimNext(registered.token, {
    appVersion: "2.4.5",
    capabilities: ["accessibility"]
  });

  assert.equal(job?.rule.standardModel, "MDR-7506");
  assert.deepEqual(job?.rule.effectiveAliases, ["7506"]);
  assert.deepEqual(job?.ownListings.map((listing) => listing.id), ["own-active-1", "own-active-2"]);
  assert.equal(job?.collectorId, repository.agents[0]?.id);
});

test("heartbeat updates only the owning agent's running job", async () => {
  const repository = new InMemoryCollectorAgentRepository();
  const service = new CollectorAgentService(repository);
  const owner = await registerAgent(service, "owner-mac");
  const other = await registerAgent(service, "other-mac");
  const run = repository.addRun({ id: "run-heartbeat" });
  await service.claimNext(owner.token, { appVersion: "2.4.5", capabilities: [] });

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
    await service.claimNext(registered.token, { appVersion: "2.4.5", capabilities: [] });

    await service.pause(registered.token, run.id, code, "operator action required");
    assert.equal(run.status, status);
    assert.equal(run.errorCode, code);
    assert.equal(
      await service.claimNext(registered.token, { appVersion: "2.4.5", capabilities: [] }),
      null
    );

    repository.requeue(run.id);
    assert.equal(
      (await service.claimNext(registered.token, { appVersion: "2.4.5", capabilities: [] }))?.runId,
      run.id
    );
  }
});
