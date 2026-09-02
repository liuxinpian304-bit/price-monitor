import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorJob, CollectorReport } from "@stau-price-monitor/contracts";

import { CollectionInterruptedError } from "../core/collection-runner.ts";
import {
  CollectorWorker,
  type CollectorWorkerApi,
  type CollectorWorkerCheckpoint,
  type CollectorWorkerCheckpointStore,
  type CollectorWorkerOptions,
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
  ownListings: [{
    id: "own-1",
    url: "https://item.example.test/item.htm?id=1001",
    skuText: "Black"
  }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    colorComparable: false,
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
    ...(status === "SUCCEEDED" ? { searchTerminationReason: "END_MARKER" as const } : {}),
    positions: [],
    ownItems: status === "SUCCEEDED" ? [{
      ownListingId: "own-1",
      platformItemId: "1001",
      url: "https://item.example.test/item.htm?id=1001",
      shopName: "Own Shop",
      title: "Sony MDR-7506",
      searchRanks: [],
      skus: [{
        skuId: `sku_${"a".repeat(64)}`,
        label: "Black",
        attributes: { color: "Black" },
        stockState: "IN_STOCK",
        listPriceFen: 1_000,
        activityPriceFen: 1_000,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        promotions: [],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 1_000,
        capturedAt: "2026-08-24T01:00:30.000Z",
        evidenceKey: null
      }]
    }] : [],
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
  releaseCalls: string[] = [];
  releaseInputs: Array<{ disposition: "QUARANTINE"; errorCode: "INVALID_CHECKPOINT" } | undefined> = [];
  reportCalls = 0;
  reportStatuses: CollectorReport["status"][] = [];
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

  async release(
    runId: string,
    input?: { disposition: "QUARANTINE"; errorCode: "INVALID_CHECKPOINT" }
  ) {
    this.releaseCalls.push(runId);
    this.releaseInputs.push(input);
  }

  async uploadReport(_runId: string, inputReport: CollectorReport) {
    this.reportCalls += 1;
    this.reportStatuses.push(inputReport.status);
    if (this.reportFailure) throw this.reportFailure;
    return {
      runId: "run-1",
      status: "SUCCEEDED" as const,
      positionCount: 0,
      uniqueItemCount: 0,
      skuCount: inputReport.status === "SUCCEEDED" ? 1 : 0,
      issueCount: 0,
      ownSnapshotIds: inputReport.status === "SUCCEEDED" ? ["own-snapshot-1"] : [],
      competitorSnapshotIds: []
    };
  }
}

class FakeStore implements CollectorWorkerCheckpointStore {
  loadCalls = 0;
  removeCalls = 0;
  checkpoint: CollectorWorkerCheckpoint | null = {
    phase: "COMPLETE" as const,
    completedSkuKeys: ["sku-1", "sku-2"],
    report: report(),
    evidenceManifest: {}
  };

  async load() {
    this.loadCalls += 1;
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
  manifests: Record<string, string>[] = [];

  async upload(_runId: string, manifest: Record<string, string>) {
    this.uploadCalls += 1;
    this.manifests.push(manifest);
    if (this.failure) throw this.failure;
    return { uploadedCount: 0, totalCount: 0 };
  }

  clear() {
    this.clearCalls += 1;
  }
}

class ManualScheduler implements WorkerScheduler {
  private nextId = 1;
  now = 0;
  readonly timers = new Map<number, {
    callback: () => void;
    deadline: number;
    milliseconds: number;
  }>();

  setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, deadline: this.now + milliseconds, milliseconds });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  fireNext(): void {
    const entry = [...this.timers.entries()]
      .sort((left, right) => left[1].deadline - right[1].deadline)[0];
    assert.ok(entry);
    this.timers.delete(entry[0]);
    this.now = entry[1].deadline;
    entry[1].callback();
  }

  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const entry = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (!entry) break;
      this.timers.delete(entry[0]);
      this.now = entry[1].deadline;
      entry[1].callback();
    }
    this.now = target;
  }
}

function createWorker(overrides: {
  api?: FakeApi;
  store?: FakeStore;
  uploader?: FakeUploader;
  runner?: CollectorWorkerRunner;
  scheduler?: ManualScheduler;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log?: (summary: Parameters<NonNullable<CollectorWorkerOptions["log"]>>[0]) => void;
} = {}) {
  const api = overrides.api ?? new FakeApi();
  const store = overrides.store ?? new FakeStore();
  const uploader = overrides.uploader ?? new FakeUploader();
  const scheduler = overrides.scheduler ?? new ManualScheduler();
  const runner = overrides.runner ?? { run: async () => report() };
  const options: CollectorWorkerOptions = {
    api,
    checkpointStore: store,
    evidenceUploader: uploader,
    runnerFactory: () => runner,
    scheduler,
    sleep: overrides.sleep ?? (async () => undefined),
    appVersion: "2.4.5",
    capabilities: ["accessibility", "png-evidence"],
    log: overrides.log ?? (() => undefined)
  };
  if (overrides.monotonicNow) options.monotonicNow = overrides.monotonicNow;
  const worker = new CollectorWorker(options);
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

test("worker waits after a transient claim failure and continues claiming", async () => {
  const api = new FakeApi();
  const transient = Object.assign(new Error("unsafe transport detail"), {
    code: "SERVICE_UNAVAILABLE",
    transient: true
  });
  let worker!: CollectorWorker;
  api.claim = async () => {
    api.claimCalls += 1;
    if (api.claimCalls === 1) throw transient;
    worker.stop();
    return null;
  };
  const waits: number[] = [];
  const logs: Array<Parameters<NonNullable<CollectorWorkerOptions["log"]>>[0]> = [];
  ({ worker } = createWorker({
    api,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    log: (summary) => { logs.push(summary); }
  }));

  await worker.run();
  assert.equal(api.claimCalls, 2);
  assert.deepEqual(waits, [30_000]);
  assert.deepEqual(logs, [{
    event: "claim_failed",
    runId: null,
    phase: null,
    discoveredCount: 0,
    skuCount: 0,
    errorCode: "SERVICE_UNAVAILABLE"
  }]);
  assert.equal(JSON.stringify(logs).includes("unsafe transport detail"), false);
});

test("SIGTERM during polling wait stops future claims deterministically", async () => {
  const api = new FakeApi();
  api.claim = async () => {
    api.claimCalls += 1;
    throw Object.assign(new Error("unsafe timeout detail"), {
      code: "TIMEOUT",
      transient: true
    });
  };
  let waitStarted!: () => void;
  const started = new Promise<void>((resolve) => { waitStarted = resolve; });
  const { worker } = createWorker({
    api,
    sleep: async (milliseconds, signal) => {
      assert.equal(milliseconds, 30_000);
      waitStarted();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
        once: true
      }));
    }
  });

  const running = worker.run();
  await started;
  worker.stop();
  await running;
  assert.equal(api.claimCalls, 1);
});

test("worker mode does not swallow a non-transient claim failure", async () => {
  const api = new FakeApi();
  api.claim = async () => {
    api.claimCalls += 1;
    throw Object.assign(new Error("unsafe authentication detail"), {
      code: "AUTHENTICATION_FAILED",
      transient: false
    });
  };
  const waits: number[] = [];
  const { worker } = createWorker({
    api,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  await assert.rejects(() => worker.run(), { code: "AUTHENTICATION_FAILED" });
  assert.equal(api.claimCalls, 1);
  assert.deepEqual(waits, []);
});

test("once makes at most one claim when that claim fails transiently", async () => {
  const api = new FakeApi();
  api.claim = async () => {
    api.claimCalls += 1;
    throw Object.assign(new Error("unsafe transport detail"), {
      code: "NETWORK_ERROR",
      transient: true
    });
  };
  const { worker } = createWorker({ api });

  await assert.rejects(() => worker.once(), { code: "NETWORK_ERROR" });
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
  const checkpoint = store.checkpoint;
  assert.ok(checkpoint);
  checkpoint.report.positions = [{}, {}, {}] as never;
  let release!: (value: CollectorReport) => void;
  const runner: CollectorWorkerRunner = {
    run: async () => new Promise<CollectorReport>((resolve) => { release = resolve; })
  };
  const { worker } = createWorker({ scheduler, api, store, runner });
  const running = worker.once();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.heartbeatCalls, 1);
  assert.deepEqual(api.lastHeartbeat, {
    runId: "run-1",
    input: { discoveredCount: 3, skuCount: 2 }
  });

  checkpoint.report = report();
  release(report());
  await running;
});

test("heartbeat keeps 30-second start deadlines after a 15-second request", async () => {
  const scheduler = new ManualScheduler();
  const api = new FakeApi();
  const starts: number[] = [];
  let finishFirst!: () => void;
  api.heartbeat = async () => {
    starts.push(scheduler.now);
    if (starts.length === 1) {
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      throw Object.assign(new Error("unsafe timeout detail"), {
        code: "TIMEOUT",
        transient: true
      });
    }
  };
  let releaseRunner!: (value: CollectorReport) => void;
  const runner: CollectorWorkerRunner = {
    run: async () => new Promise<CollectorReport>((resolve) => { releaseRunner = resolve; })
  };
  const { worker } = createWorker({
    api,
    runner,
    scheduler,
    monotonicNow: () => scheduler.now
  });

  const running = worker.once();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0]);
  scheduler.advanceBy(15_000);
  finishFirst();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.advanceBy(14_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0]);
  scheduler.advanceBy(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 30_000]);

  releaseRunner(report());
  await running;
});

test("heartbeat skips missed ticks without overlap or a catch-up burst", async () => {
  const scheduler = new ManualScheduler();
  const api = new FakeApi();
  const starts: number[] = [];
  let finishFirst!: () => void;
  api.heartbeat = async () => {
    starts.push(scheduler.now);
    if (starts.length === 1) {
      await new Promise<void>((resolve) => { finishFirst = resolve; });
    }
  };
  let releaseRunner!: (value: CollectorReport) => void;
  const runner: CollectorWorkerRunner = {
    run: async () => new Promise<CollectorReport>((resolve) => { releaseRunner = resolve; })
  };
  const { worker } = createWorker({
    api,
    runner,
    scheduler,
    monotonicNow: () => scheduler.now
  });

  const running = worker.once();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.advanceBy(75_000);
  assert.deepEqual(starts, [0]);
  finishFirst();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.advanceBy(15_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 90_000]);

  releaseRunner(report());
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

test("submits a valid FAILED report when no checkpoint was created", async () => {
  const store = new FakeStore();
  store.checkpoint = null;
  const { worker, api, uploader } = createWorker({
    store,
    runner: { run: async () => report("FAILED") }
  });

  assert.equal(await worker.once(), "processed");
  assert.deepEqual(api.reportStatuses, ["FAILED"]);
  assert.equal(uploader.uploadCalls, 0);
  assert.equal(store.removeCalls, 0);
});

test("uploads a valid non-COMPLETE manifest before submitting PARTIAL_FAILED", async () => {
  const store = new FakeStore();
  const partialReport = report("PARTIAL_FAILED");
  const manifest = { [`sha256:${"a".repeat(64)}`]: "capture.png" };
  store.checkpoint = {
    phase: "ITEMS",
    completedSkuKeys: ["sku-1"],
    report: report("FAILED"),
    evidenceManifest: manifest
  };
  const { worker, api, uploader } = createWorker({
    store,
    runner: { run: async () => partialReport }
  });

  assert.equal(await worker.once(), "processed");
  assert.deepEqual(uploader.manifests, [manifest]);
  assert.deepEqual(api.reportStatuses, ["PARTIAL_FAILED"]);
  assert.equal(store.removeCalls, 1);
});

test("evidence body timeout makes exactly three attempts without checkpoint acknowledgement", async () => {
  const uploader = new FakeUploader();
  uploader.failure = Object.assign(new Error("unsafe response"), {
    code: "TIMEOUT",
    transient: true
  });
  const waits: number[] = [];
  const { worker, store, api } = createWorker({
    uploader,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  await assert.rejects(() => worker.once(), { code: "TIMEOUT" });
  assert.equal(uploader.uploadCalls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(api.reportCalls, 0);
  assert.equal(store.removeCalls, 0);
});

test("report body timeout makes exactly three attempts without checkpoint acknowledgement", async () => {
  const api = new FakeApi();
  api.reportFailure = Object.assign(new Error("unsafe response"), {
    code: "TIMEOUT",
    transient: true
  });
  const waits: number[] = [];
  const { worker, store, uploader } = createWorker({
    api,
    sleep: async (milliseconds) => { waits.push(milliseconds); }
  });

  await assert.rejects(() => worker.once(), { code: "TIMEOUT" });
  assert.equal(api.reportCalls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(uploader.uploadCalls, 1);
  assert.equal(store.removeCalls, 0);
  assert.equal(uploader.clearCalls, 0);
  assert.deepEqual(api.releaseCalls, ["run-1"]);
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
  assert.deepEqual(api.releaseCalls, ["run-1"]);
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
  assert.deepEqual(api.releaseCalls, ["run-1"]);
});

test("collection failure requeues the owned run without deleting its durable checkpoint", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  const { worker } = createWorker({
    api,
    store,
    runner: { run: async () => { throw new Error("collector failed"); } }
  });

  await assert.rejects(() => worker.once(), { code: "COLLECTION_FAILED" });
  assert.deepEqual(api.releaseCalls, ["run-1"]);
  assert.equal(store.removeCalls, 0);
});

test("quarantines deterministic checkpoint failure without acknowledging its evidence", async () => {
  const api = new FakeApi();
  const store = new FakeStore();
  const uploader = new FakeUploader();
  const checkpointError = Object.assign(new TypeError("checkpoint is invalid"), {
    code: "INVALID_CHECKPOINT" as const
  });
  const { worker } = createWorker({
    api,
    store,
    uploader,
    runner: { run: async () => { throw checkpointError; } }
  });

  await assert.rejects(() => worker.once(), { code: "CHECKPOINT_FAILED" });
  assert.deepEqual(api.releaseCalls, ["run-1"]);
  assert.deepEqual(api.releaseInputs, [{
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  }]);
  assert.equal(store.removeCalls, 0);
  assert.equal(uploader.clearCalls, 0);
});

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
