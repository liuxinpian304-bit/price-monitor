import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorJob, CollectorReport } from "@stau-price-monitor/contracts";

import { CollectionInterruptedError } from "../core/collection-runner.ts";
import {
  CollectorWorker,
  type CollectorWorkerApi,
  type CollectorWorkerCheckpointStore,
  type CollectorWorkerRunner,
  type WorkerEvidenceUploader,
  type WorkerScheduler
} from "./collector-worker.ts";

const job: CollectorJob = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-1",
  monitoredModelId: "model-1",
  searchQuery: "Sony MDR-7506",
  searchLimit: 3,
  ownShopName: "Own Shop",
  ownListings: [],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    effectiveAliases: ["7506"],
    excludedAliases: [],
    mustIncludeTerms: [],
    excludedTerms: []
  }
};

function report(status: CollectorReport["status"] = "SUCCEEDED"): CollectorReport {
  const pauseCode = status === "PAUSED_LOGIN"
    ? "LOGIN_REQUIRED"
    : status === "PAUSED_CHALLENGE" ? "PLATFORM_CHALLENGE" : null;
  return {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "agent-1",
    appVersion: "2.4.5",
    startedAt: "2026-08-24T01:00:00.000Z",
    completedAt: "2026-08-24T01:01:00.000Z",
    status,
    searchLimit: 3,
    positions: [],
    ownItems: [],
    competitorItems: [],
    issues: pauseCode ? [{
      code: pauseCode,
      message: "fixed pause reason",
      capturedAt: "2026-08-24T01:01:00.000Z"
    }] : []
  };
}

class FakeApi implements CollectorWorkerApi {
  claims: Array<CollectorJob | null> = [job];
  claimCalls = 0;
  heartbeatCalls = 0;
  lastHeartbeat: { runId: string; input: { discoveredCount: number; skuCount: number } } | null = null;
  pauseCalls: Array<{ runId: string; code: string; message: string }> = [];
  reportCalls = 0;
  reportFailure: Error | null = null;

  async claim() {
    this.claimCalls += 1;
    return this.claims.shift() ?? null;
  }

  async heartbeat(runId: string, input: { discoveredCount: number; skuCount: number }) {
    this.heartbeatCalls += 1;
    this.lastHeartbeat = { runId, input };
  }

  async pause(runId: string, code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE", message: string) {
    this.pauseCalls.push({ runId, code, message });
  }

  async uploadReport() {
    this.reportCalls += 1;
    if (this.reportFailure) throw this.reportFailure;
    return {
      runId: "run-1",
      status: "SUCCEEDED" as const,
      positionCount: 0,
      uniqueItemCount: 0,
      skuCount: 0,
      issueCount: 0,
      ownSnapshotIds: [],
      competitorSnapshotIds: []
    };
  }
}

class FakeStore implements CollectorWorkerCheckpointStore {
  removeCalls = 0;
  checkpoint = {
    phase: "COMPLETE" as const,
    completedSkuKeys: ["sku-1", "sku-2"],
    report: report(),
    evidenceManifest: {}
  };

  async load() {
    return this.checkpoint;
  }

  async remove() {
    this.removeCalls += 1;
  }
}

class FakeUploader implements WorkerEvidenceUploader {
  uploadCalls = 0;
  clearCalls = 0;
  failure: Error | null = null;

  async upload() {
    this.uploadCalls += 1;
    if (this.failure) throw this.failure;
    return { uploadedCount: 0, totalCount: 0 };
  }

  clear() {
    this.clearCalls += 1;
  }
}

class ManualScheduler implements WorkerScheduler {
  private nextId = 1;
  readonly timers = new Map<number, { callback: () => void; milliseconds: number }>();

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, milliseconds });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  fireNext(): void {
    const entry = this.timers.entries().next().value as [number, { callback: () => void }] | undefined;
    assert.ok(entry);
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

function createWorker(overrides: {
  api?: FakeApi;
  store?: FakeStore;
  uploader?: FakeUploader;
  runner?: CollectorWorkerRunner;
  scheduler?: ManualScheduler;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  const api = overrides.api ?? new FakeApi();
  const store = overrides.store ?? new FakeStore();
  const uploader = overrides.uploader ?? new FakeUploader();
  const scheduler = overrides.scheduler ?? new ManualScheduler();
  const runner = overrides.runner ?? { run: async () => report() };
  const worker = new CollectorWorker({
    api,
    checkpointStore: store,
    evidenceUploader: uploader,
    runnerFactory: () => runner,
    scheduler,
    sleep: overrides.sleep ?? (async () => undefined),
    appVersion: "2.4.5",
    capabilities: ["accessibility", "png-evidence"],
    log: () => undefined
  });
  return { worker, api, store, uploader, scheduler };
}

test("once claims one job, runs it, uploads one validated report, and exits", async () => {
  let runnerCalls = 0;
  const { worker, api, store, uploader } = createWorker({
    runner: {
      async run(claimedJob, collectorId) {
        runnerCalls += 1;
        assert.deepEqual(claimedJob, job);
        assert.equal(collectorId, "agent-1");
        return report();
      }
    }
  });

  assert.equal(await worker.once(), "processed");
  assert.equal(api.claimCalls, 1);
  assert.equal(runnerCalls, 1);
  assert.equal(uploader.uploadCalls, 1);
  assert.equal(api.reportCalls, 1);
  assert.equal(store.removeCalls, 1);
  assert.equal(uploader.clearCalls, 1);
});

test("worker waits exactly 30 seconds after a 204-equivalent empty claim", async () => {
  const api = new FakeApi();
  api.claims = [null];
  const waits: number[] = [];
  let worker!: CollectorWorker;
  ({ worker } = createWorker({
    api,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      worker.stop();
    }
  }));

  await worker.run();
  assert.deepEqual(waits, [30_000]);
  assert.equal(api.claimCalls, 1);
});

test("heartbeat starts after claim and is fully stopped before evidence upload", async () => {
  const scheduler = new ManualScheduler();
  const uploader = new FakeUploader();
  uploader.upload = async () => {
    assert.equal(scheduler.timers.size, 0);
    uploader.uploadCalls += 1;
    return { uploadedCount: 0, totalCount: 0 };
  };
  const runner: CollectorWorkerRunner = {
    async run() {
      assert.equal(scheduler.timers.size, 1);
      assert.equal([...scheduler.timers.values()][0]?.milliseconds, 30_000);
      return report();
    }
  };
  const { worker } = createWorker({ scheduler, uploader, runner });

  await worker.once();
  assert.equal(scheduler.timers.size, 0);
});

test("heartbeat publishes checkpoint position and completed-SKU counts", async () => {
  const scheduler = new ManualScheduler();
  const api = new FakeApi();
  const store = new FakeStore();
  store.checkpoint.report.positions = [{}, {}, {}] as never;
  let release!: (value: CollectorReport) => void;
  const runner: CollectorWorkerRunner = {
    run: async () => new Promise<CollectorReport>((resolve) => { release = resolve; })
  };
  const { worker } = createWorker({ scheduler, api, store, runner });
  const running = worker.once();
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.heartbeatCalls, 1);
  assert.deepEqual(api.lastHeartbeat, {
    runId: "run-1",
    input: { discoveredCount: 3, skuCount: 2 }
  });

  store.checkpoint.report = report();
  release(report());
  await running;
});

test("login and challenge reports pause without evidence or successful-report upload", async () => {
  for (const [status, code] of [
    ["PAUSED_LOGIN", "LOGIN_REQUIRED"],
    ["PAUSED_CHALLENGE", "PLATFORM_CHALLENGE"]
  ] as const) {
    const api = new FakeApi();
    const store = new FakeStore();
    const uploader = new FakeUploader();
    const { worker } = createWorker({
      api,
      store,
      uploader,
      runner: { run: async () => report(status) }
    });

    assert.equal(await worker.once(), "paused");
    assert.equal(api.pauseCalls.length, 1);
    assert.equal(api.pauseCalls[0]?.code, code);
    assert.equal(api.reportCalls, 0);
    assert.equal(uploader.uploadCalls, 0);
    assert.equal(store.removeCalls, 0);
  }
});

test("transient evidence failure makes exactly three attempts with bounded exponential delays", async () => {
  const uploader = new FakeUploader();
  uploader.failure = Object.assign(new Error("unsafe response"), {
    code: "SERVICE_UNAVAILABLE",
    transient: true
  });
  const waits: number[] = [];
  const { worker, store, api } = createWorker({
    uploader,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  await assert.rejects(() => worker.once(), { code: "SERVICE_UNAVAILABLE" });
  assert.equal(uploader.uploadCalls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(api.reportCalls, 0);
  assert.equal(store.removeCalls, 0);
});

test("report retries three attempts and removes the checkpoint only after acknowledgement", async () => {
  const api = new FakeApi();
  const transient = Object.assign(new Error("unsafe response"), {
    code: "SERVICE_UNAVAILABLE",
    transient: true
  });
  api.uploadReport = async () => {
    api.reportCalls += 1;
    if (api.reportCalls < 3) throw transient;
    return {
      runId: "run-1",
      status: "SUCCEEDED" as const,
      positionCount: 0,
      uniqueItemCount: 0,
      skuCount: 0,
      issueCount: 0,
      ownSnapshotIds: [],
      competitorSnapshotIds: []
    };
  };
  const waits: number[] = [];
  const { worker, store, uploader } = createWorker({
    api,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  await worker.once();
  assert.equal(api.reportCalls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(uploader.uploadCalls, 1);
  assert.equal(store.removeCalls, 1);
});

test("authentication, validation, and conflict failures are never retried", async () => {
  for (const code of ["AUTHENTICATION_FAILED", "VALIDATION_FAILED", "CONFLICT"]) {
    const api = new FakeApi();
    api.reportFailure = Object.assign(new Error("unsafe response"), { code, transient: false });
    const waits: number[] = [];
    const { worker, store } = createWorker({
      api,
      sleep: async (milliseconds) => { waits.push(milliseconds); }
    });

    await assert.rejects(() => worker.once(), { code });
    assert.equal(api.reportCalls, 1);
    assert.deepEqual(waits, []);
    assert.equal(store.removeCalls, 0);
  }
});

test("does not delete the checkpoint while report acknowledgement is in flight", async () => {
  const api = new FakeApi();
  let acknowledge!: () => void;
  let started!: () => void;
  const reportStarted = new Promise<void>((resolve) => { started = resolve; });
  api.uploadReport = async () => {
    api.reportCalls += 1;
    started();
    await new Promise<void>((resolve) => { acknowledge = resolve; });
    return {
      runId: "run-1",
      status: "SUCCEEDED" as const,
      positionCount: 0,
      uniqueItemCount: 0,
      skuCount: 0,
      issueCount: 0,
      ownSnapshotIds: [],
      competitorSnapshotIds: []
    };
  };
  const { worker, store } = createWorker({ api });

  const running = worker.once();
  await reportStarted;
  assert.equal(store.removeCalls, 0);
  acknowledge();
  await running;
  assert.equal(store.removeCalls, 1);
});

test("graceful stop aborts at the runner boundary and preserves unacknowledged progress", async () => {
  let started!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
  const runner: CollectorWorkerRunner = {
    async run(_job, _collectorId, signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new CollectionInterruptedError()), { once: true });
      });
      throw new Error("unreachable");
    }
  };
  const { worker, store, uploader, api, scheduler } = createWorker({ runner });

  const running = worker.once();
  await runnerStarted;
  worker.stop();
  assert.equal(await running, "stopped");
  assert.equal(scheduler.timers.size, 0);
  assert.equal(uploader.uploadCalls, 0);
  assert.equal(api.reportCalls, 0);
  assert.equal(store.removeCalls, 0);
});

test("a runner-factory failure cannot leave a heartbeat timer behind", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  const uploader = new FakeUploader();
  const scheduler = new ManualScheduler();
  const worker = new CollectorWorker({
    api,
    checkpointStore: store,
    evidenceUploader: uploader,
    runnerFactory: () => { throw new Error("factory failed"); },
    scheduler,
    sleep: async () => undefined,
    appVersion: "2.4.5",
    capabilities: [],
    log: () => undefined
  });

  await assert.rejects(() => worker.once());
  assert.equal(scheduler.timers.size, 0);
});
