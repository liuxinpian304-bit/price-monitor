import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectionRunQueueService,
  type CollectionRunQueueRepository,
  type QueuedCollectionRun
} from "./collection-run-queue.service.ts";

class MemoryQueueRepository implements CollectionRunQueueRepository {
  readonly models = [
    { id: "model-enabled", enabled: true },
    { id: "model-disabled", enabled: false }
  ];
  readonly runs: QueuedCollectionRun[] = [];
  collectorSessionState: "READY" | "LOGIN_REQUIRED" = "READY";

  async listEnabledModels() {
    return this.models.filter((model) => model.enabled);
  }

  async getEnabledModel(modelId: string) {
    return this.models.find((model) => model.id === modelId && model.enabled) ?? null;
  }

  async createOrCoalesce(input: {
    monitoredModelId: string;
    providerKey: "taobao-desktop";
    scheduledFor: Date;
    searchLimit: number;
    actorId: string | null;
  }) {
    const existingSlot = this.runs.find((run) => run.monitoredModelId === input.monitoredModelId
      && run.providerKey === input.providerKey
      && run.scheduledFor.getTime() === input.scheduledFor.getTime());
    if (existingSlot) return { run: existingSlot, coalesced: existingSlot.status === "COALESCED" };

    const active = this.runs.find((run) => run.monitoredModelId === input.monitoredModelId
      && ["QUEUED", "RUNNING", "PAUSED_LOGIN", "PAUSED_CHALLENGE"].includes(run.status));
    const run: QueuedCollectionRun = {
      id: `run-${this.runs.length + 1}`,
      monitoredModelId: input.monitoredModelId,
      providerKey: input.providerKey,
      scheduledFor: input.scheduledFor,
      searchLimit: input.searchLimit,
      status: active ? "COALESCED" : "QUEUED",
      coalescedIntoRunId: active?.id ?? null,
      actorId: input.actorId
    };
    this.runs.push(run);
    return { run, coalesced: Boolean(active) };
  }

  async requeuePaused(runId: string) {
    const run = this.runs.find((entry) => entry.id === runId);
    if (!run || this.collectorSessionState !== "READY"
      || (run.status !== "PAUSED_LOGIN" && run.status !== "PAUSED_CHALLENGE")) return null;
    run.status = "QUEUED";
    return run;
  }
}

test("scheduled slots create one desktop queued run per enabled model with a fixed 50 result limit", async () => {
  const repository = new MemoryQueueRepository();
  const service = new CollectionRunQueueService(repository);
  const scheduledFor = new Date("2026-08-25T01:30:00.000Z");

  const result = await service.enqueueEnabledModels(scheduledFor);

  assert.deepEqual(result.map((entry) => entry.run), [{
    id: "run-1",
    monitoredModelId: "model-enabled",
    providerKey: "taobao-desktop",
    scheduledFor,
    searchLimit: 50,
    status: "QUEUED",
    coalescedIntoRunId: null,
    actorId: null
  }]);
});

test("duplicate scheduled delivery is idempotent while later overlapping work is coalesced", async () => {
  const repository = new MemoryQueueRepository();
  const service = new CollectionRunQueueService(repository);
  const firstSlot = new Date("2026-08-25T01:30:00.000Z");

  await service.enqueueEnabledModels(firstSlot);
  const duplicate = await service.enqueueEnabledModels(firstSlot);
  const overlap = await service.enqueueModelNow("model-enabled", "admin-1", 7, new Date("2026-08-25T02:30:00.000Z"));

  assert.equal(repository.runs.length, 2);
  assert.equal(duplicate[0]?.run.id, "run-1");
  assert.equal(duplicate[0]?.coalesced, false);
  assert.deepEqual(overlap, {
    runId: "run-1",
    coalesced: true
  });
  assert.equal(repository.runs[1]?.coalescedIntoRunId, "run-1");
  assert.equal(repository.runs[1]?.searchLimit, 7);
});

test("manual enqueue validates enabled models and requeues only paused runs", async () => {
  const repository = new MemoryQueueRepository();
  const service = new CollectionRunQueueService(repository);

  await assert.rejects(() => service.enqueueModelNow("missing", "admin-1"));
  const result = await service.enqueueModelNow("model-enabled", "admin-1");
  repository.runs[0]!.status = "PAUSED_LOGIN";

  assert.deepEqual(await service.requeuePausedRun(result.runId), { runId: result.runId });
  repository.runs[0]!.status = "SUCCEEDED";
  await assert.rejects(() => service.requeuePausedRun(result.runId));
});

test("manual requeue cannot restart a paused run while the fixed collector session is blocked", async () => {
  const repository = new MemoryQueueRepository();
  const service = new CollectionRunQueueService(repository);
  const result = await service.enqueueModelNow("model-enabled", "admin-1");
  repository.runs[0]!.status = "PAUSED_LOGIN";
  repository.collectorSessionState = "LOGIN_REQUIRED";

  await assert.rejects(() => service.requeuePausedRun(result.runId));
  assert.equal(repository.runs[0]!.status, "PAUSED_LOGIN");
});
