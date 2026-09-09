import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  AxHelperDiagnosticPayload
} from "../drivers/macos/ax-helper-client.ts";
import type { AxNode } from "../drivers/macos/ax-node.ts";
import { TaobaoSessionObserver } from "./taobao-session-observer.ts";

const observedAt = "2026-09-09T01:30:00.000Z";
const healthyDiagnostic: AxHelperDiagnosticPayload = {
  appInstalled: true,
  trusted: true,
  screenRecordingTrusted: true,
  appRunning: true,
  pid: 123,
  bundleId: "com.taobao.pcdesktop",
  shortVersion: "2.4.5",
  build: "15",
  frontWindowAvailable: true
};

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

class FakeAxClient {
  readonly commands: string[] = [];
  readonly diagnostic: AxHelperDiagnosticPayload;
  readonly root: AxNode | Error;
  closed = false;

  constructor(
    diagnostic: AxHelperDiagnosticPayload = healthyDiagnostic,
    root: AxNode | Error = new Error("snapshot unavailable")
  ) {
    this.diagnostic = diagnostic;
    this.root = root;
  }

  async diagnose(): Promise<AxHelperDiagnosticPayload> {
    this.commands.push("diagnose");
    return this.diagnostic;
  }

  async snapshot(): Promise<AxNode> {
    this.commands.push("snapshot");
    if (this.root instanceof Error) throw this.root;
    return this.root;
  }

  close(): void {
    this.closed = true;
  }
}

test("observes a ready Taobao session without activating or mutating the app", async () => {
  const client = new FakeAxClient(healthyDiagnostic, await fixture("search-results.json"));
  const observer = new TaobaoSessionObserver(client, () => observedAt);

  const observation = await observer.observe();

  assert.deepEqual(observation, { state: "READY", observedAt });
  assert.deepEqual(client.commands, ["diagnose", "snapshot"]);
  assert.equal(client.commands.includes("activate"), false);
});

test("classifies the existing strict login fixture as login required", async () => {
  const client = new FakeAxClient(healthyDiagnostic, await fixture("login-required.json"));
  const observer = new TaobaoSessionObserver(client, () => observedAt);

  assert.deepEqual(await observer.observe(), { state: "LOGIN_REQUIRED", observedAt });
  assert.deepEqual(client.commands, ["diagnose", "snapshot"]);
});

test("classifies a platform challenge as challenge required", async () => {
  const client = new FakeAxClient(healthyDiagnostic, await fixture("platform-challenge.json"));
  const observer = new TaobaoSessionObserver(client, () => observedAt);

  assert.deepEqual(await observer.observe(), { state: "CHALLENGE_REQUIRED", observedAt });
  assert.deepEqual(client.commands, ["diagnose", "snapshot"]);
});

for (const [name, diagnostic] of [
  ["missing app", { ...healthyDiagnostic, appInstalled: false }],
  ["stopped app", { ...healthyDiagnostic, appRunning: false }],
  ["missing accessibility permission", { ...healthyDiagnostic, trusted: false }],
  ["missing screen-recording permission", {
    ...healthyDiagnostic,
    screenRecordingTrusted: false
  }],
  ["missing front window", { ...healthyDiagnostic, frontWindowAvailable: false }],
  ["unsupported app version", { ...healthyDiagnostic, shortVersion: "2.4.6" }],
  ["unsupported app build", { ...healthyDiagnostic, build: "16" }]
] as const) {
  test(`classifies ${name} as unavailable without requesting a snapshot`, async () => {
    const client = new FakeAxClient(diagnostic);
    const observer = new TaobaoSessionObserver(client, () => observedAt);

    assert.deepEqual(await observer.observe(), { state: "UNAVAILABLE", observedAt });
    assert.deepEqual(client.commands, ["diagnose"]);
  });
}

test("classifies a failed safe snapshot as unavailable", async () => {
  const client = new FakeAxClient();
  const observer = new TaobaoSessionObserver(client, () => observedAt);

  assert.deepEqual(await observer.observe(), { state: "UNAVAILABLE", observedAt });
  assert.deepEqual(client.commands, ["diagnose", "snapshot"]);
});

test("closes the owned AX client", () => {
  const client = new FakeAxClient();
  const observer = new TaobaoSessionObserver(client, () => observedAt);

  observer.close();

  assert.equal(client.closed, true);
});
