import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";

import type { DriverDiagnostic } from "./core/desktop-driver.ts";
import {
  CollectorCliError,
  runCollectorCli,
  type CollectorCliApi,
  type CollectorCliWorker
} from "./main.ts";

const token = `pmc_${"C".repeat(43)}`;
const pairingTokenName = ["COLLECTOR", "PAIRING", "TOKEN"].join("_");
const environment = {
  COLLECTOR_API_URL: "http://127.0.0.1:4100",
  [pairingTokenName]: token,
  COLLECTOR_NAME: "collector-account-value",
  TAOBAO_AX_HELPER_PATH: "apps/collector-macos/.build/debug/taobao-ax-helper",
  COLLECTOR_WORK_DIR: "work/collector-runs"
};

const diagnostic: DriverDiagnostic = {
  accessibilityTrusted: true,
  appRunning: true,
  processId: 123,
  bundleId: "com.taobao.pcdesktop",
  appVersion: "2.4.5",
  appBuild: "15",
  hasFrontWindow: true,
  loginState: "LOGGED_IN",
  rawEvidence: {
    source: "test",
    capturedAt: "2026-08-24T01:00:00.000Z",
    metadata: { account: "must-not-log" }
  }
};

class FakeCliApi implements CollectorCliApi {
  reachabilityCalls = 0;
  pairingCalls = 0;
  claimCalls = 0;

  async checkReachability() {
    this.reachabilityCalls += 1;
    return {
      status: "ok" as const,
      database: "up" as const,
      redis: "up" as const,
      collection: { status: "NO_RUN", finishedAt: null },
      checkedAt: "2026-08-24T01:00:00.000Z"
    };
  }

  async checkPairing() {
    this.pairingCalls += 1;
  }

  async claim(): Promise<never> {
    this.claimCalls += 1;
    throw new Error("diagnose must not claim");
  }
}

test("diagnose checks the helper, API, pairing, and desktop state without claiming", async () => {
  const api = new FakeCliApi();
  const accessed: Array<{ path: string; mode: number }> = [];
  const logs: unknown[] = [];
  let closed = 0;

  assert.equal(await runCollectorCli(["diagnose"], environment, {
    platform: "darwin",
    access: async (path, mode) => { accessed.push({ path, mode }); },
    createApi: () => api,
    createDiagnosticDriver: () => ({
      diagnose: async () => diagnostic,
      close: () => { closed += 1; }
    }),
    createWorker: () => { throw new Error("diagnose must not create a worker"); },
    installSignalHandlers: () => () => undefined,
    log: (summary) => { logs.push(summary); }
  }), "diagnosed");

  assert.equal(accessed.length, 1);
  assert.equal(accessed[0]?.mode, constants.X_OK);
  assert.equal(api.reachabilityCalls, 1);
  assert.equal(api.pairingCalls, 1);
  assert.equal(api.claimCalls, 0);
  assert.equal(closed, 1);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("collector-account-value"), false);
  assert.equal(serialized.includes("must-not-log"), false);
  assert.deepEqual(Object.keys(logs[0] as object).sort(), [
    "discoveredCount",
    "errorCode",
    "event",
    "phase",
    "runId",
    "skuCount"
  ]);
});

test("portable platforms stop before helper, API, or desktop access", async () => {
  for (const platform of ["linux", "win32"] as const) {
    let sideEffects = 0;
    await assert.rejects(
      () => runCollectorCli(["diagnose"], environment, {
        platform,
        access: async () => { sideEffects += 1; },
        createApi: () => { sideEffects += 1; return new FakeCliApi(); },
        createDiagnosticDriver: () => { sideEffects += 1; throw new Error("unreachable"); },
        createWorker: () => { sideEffects += 1; throw new Error("unreachable"); },
        installSignalHandlers: () => () => undefined,
        log: () => undefined
      }),
      (error: unknown) => error instanceof CollectorCliError && error.code === "PLATFORM_UNSUPPORTED"
    );
    assert.equal(sideEffects, 0);
  }
});

test("diagnose independently enforces the approved Taobao version and build", async () => {
  for (const changed of [
    { appVersion: "2.4.6" },
    { appBuild: "16" }
  ]) {
    await assert.rejects(
      () => runCollectorCli(["diagnose"], environment, {
        platform: "darwin",
        access: async () => undefined,
        createApi: () => new FakeCliApi(),
        createDiagnosticDriver: () => ({
          diagnose: async () => ({ ...diagnostic, ...changed }),
          close: () => undefined
        }),
        createWorker: () => { throw new Error("unreachable"); },
        installSignalHandlers: () => () => undefined,
        log: () => undefined
      }),
      (error: unknown) => error instanceof CollectorCliError
        && error.code === "TAOBAO_VERSION_UNSUPPORTED"
    );
  }
});

test("once and worker dispatch exactly one lifecycle mode and clean signal handlers", async () => {
  for (const command of ["once", "worker"] as const) {
    let onceCalls = 0;
    let runCalls = 0;
    let cleanupCalls = 0;
    const worker: CollectorCliWorker = {
      stop: () => undefined,
      once: async () => { onceCalls += 1; return "idle"; },
      run: async () => { runCalls += 1; }
    };

    assert.equal(await runCollectorCli([command], environment, {
      platform: "darwin",
      access: async () => undefined,
      createApi: () => new FakeCliApi(),
      createDiagnosticDriver: () => { throw new Error("worker command must not preflight desktop"); },
      createWorker: () => worker,
      installSignalHandlers: () => () => { cleanupCalls += 1; },
      log: () => undefined
    }), command === "once" ? "idle" : "stopped");

    assert.equal(onceCalls, command === "once" ? 1 : 0);
    assert.equal(runCalls, command === "worker" ? 1 : 0);
    assert.equal(cleanupCalls, 1);
  }
});

test("rejects missing or unknown commands with a fixed safe code", async () => {
  for (const argv of [[], ["unknown"]]) {
    await assert.rejects(
      () => runCollectorCli(argv, environment),
      (error: unknown) => error instanceof CollectorCliError && error.code === "INVALID_COMMAND"
    );
  }
});
