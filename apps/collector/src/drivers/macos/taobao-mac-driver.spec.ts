import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { DriverSearchPosition } from "../../core/desktop-driver.ts";
import type { AxHelperCommandFields, AxHelperCommandName, AxHelperDiagnosticPayload } from "./ax-helper-client.ts";
import type { AxJsonValue, AxNode } from "./ax-node.ts";
import {
  AppVersionUnsupportedError,
  MissingItemIdError,
  PriceUnstableError,
  TaobaoMacDriver,
  type TaobaoAxClient
} from "./taobao-mac-driver.ts";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

interface CommandRecord {
  command: AxHelperCommandName;
  fields: AxHelperCommandFields;
}

class FakeClient implements TaobaoAxClient {
  readonly commands: CommandRecord[] = [];
  readonly snapshotQueue: AxNode[] = [];
  diagnostic: AxHelperDiagnosticPayload = {
    trusted: true,
    appRunning: true,
    pid: 321,
    bundleId: "com.taobao.pcdesktop",
    shortVersion: "2.4.5",
    build: "15",
    frontWindowAvailable: true
  };
  snapshotSource: (() => AxNode) | null = null;
  copiedText = "https://item.example.test/item.htm?id=example-7506";

  async diagnose(): Promise<AxHelperDiagnosticPayload> {
    return structuredClone(this.diagnostic);
  }

  async snapshot(): Promise<AxNode> {
    if (this.snapshotSource) return structuredClone(this.snapshotSource());
    const next = this.snapshotQueue.shift() ?? this.snapshotQueue.at(-1);
    if (!next) throw new Error("Fake snapshot queue is empty");
    return structuredClone(next);
  }

  async command<T = AxJsonValue>(command: AxHelperCommandName, fields: AxHelperCommandFields = {}): Promise<T> {
    this.commands.push({ command, fields: structuredClone(fields) });
    if (command === "captureCopiedText") return { text: this.copiedText } as T;
    return { performed: true } as T;
  }
}

function position(overrides: Partial<DriverSearchPosition> = {}): DriverSearchPosition {
  return {
    rank: 1,
    platformItemId: "example-7506",
    url: "https://item.example.test/item.htm?id=example-7506",
    shopName: "示例音频店",
    title: "Sony MDR-7506 监听耳机",
    displayPriceMinText: "658.00",
    displayPriceMaxText: "728.00",
    sponsored: false,
    capturedAt: "2026-08-24T00:00:00.000Z",
    rawEvidence: { source: "test", capturedAt: "2026-08-24T00:00:00.000Z", metadata: {} },
    ...overrides
  };
}

function hostOnlyPosition(): DriverSearchPosition {
  return position({
    rank: 3,
    platformItemId: null,
    url: "https://item.example.test/",
    title: "MDR-7506 专业监听耳机",
    shopName: "示例器材店",
    displayPriceMinText: "699.00",
    displayPriceMaxText: "699.00"
  });
}

test("rejects every version/build mismatch before any UI mutation", async () => {
  const client = new FakeClient();
  client.diagnostic.shortVersion = "2.4.6/private";
  client.diagnostic.build = "16 secret";
  const driver = new TaobaoMacDriver({ client });

  await assert.rejects(driver.search("索尼 7506", 3), (error: unknown) => {
    assert.equal(error instanceof AppVersionUnsupportedError, true);
    assert.equal((error as AppVersionUnsupportedError).code, "APP_VERSION_UNSUPPORTED");
    assert.equal((error as Error).message, "Unsupported Taobao Desktop version 2.4.6_private build 16_secret.");
    return true;
  });
  assert.deepEqual(client.commands, []);
});

test("searches semantically and preserves duplicate result positions", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  client.snapshotQueue.push(search, search, search, search);
  const driver = new TaobaoMacDriver({ client, capturedAt: () => "2026-08-24T00:00:00.000Z" });

  const results = await driver.search("索尼 7506", 3);
  assert.deepEqual(results.map((entry) => [entry.rank, entry.platformItemId]), [
    [1, "example-7506"], [2, "example-7506"], [3, null]
  ]);
  assert.deepEqual(client.commands.map((entry) => entry.command), ["setValue", "keyPress"]);
  assert.equal(client.commands[0]?.fields.value, "索尼 7506");
  assert.equal(client.commands[1]?.fields.keyCode, 36);
});

test("resolves a host-only detail URL through restored copied-link capture", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const detail = await fixture("item-7506-default.json");
  detail.children[0]!.url = "https://item.example.test/";
  client.snapshotQueue.push(search, detail, detail, detail);
  const driver = new TaobaoMacDriver({ client, capturedAt: () => "2026-08-24T00:00:00.000Z" });

  const page = await driver.openSearchPosition(hostOnlyPosition());
  assert.equal(page.platformItemId, "example-7506");
  assert.equal(client.commands.some((entry) => entry.command === "captureCopiedText"), true);
});

test("emits MISSING_ITEM_ID when neither AXURL nor copied link has stable identity", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const detail = await fixture("item-7506-default.json");
  detail.children[0]!.url = "https://item.example.test/";
  client.copiedText = "https://item.example.test/";
  client.snapshotQueue.push(search, detail, detail, detail);
  const driver = new TaobaoMacDriver({ client });

  await assert.rejects(
    driver.openSearchPosition(hostOnlyPosition()),
    (error: unknown) => error instanceof MissingItemIdError && error.code === "MISSING_ITEM_ID"
  );
});

test("waits for exactly three stable observations and writes a flat collision-resistant PNG", async () => {
  const client = new FakeClient();
  const defaultDetail = await fixture("item-7506-default.json");
  const cableDetail = await fixture("item-7506-cable.json");
  client.snapshotQueue.push(defaultDetail, cableDetail, cableDetail, cableDetail, cableDetail);
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    capturedAt: () => "2026-08-24T00:00:00.000Z",
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    workDir: "/tmp/collector-work"
  });

  const result = await driver.selectSku({ 套装: "7506 + C口转换线", 转换线型号: "M1" });
  assert.equal(result.availability, "AVAILABLE");
  if (result.availability !== "AVAILABLE") return;
  assert.equal(result.view.activityPriceText, "728.00");
  assert.deepEqual(result.view.selectedLabels, { 套装: "7506 + C口转换线", 转换线型号: "M1" });
  assert.deepEqual(sleeps, [250, 250]);
  const screenshot = client.commands.find((entry) => entry.command === "screenshot");
  assert.equal(screenshot?.fields.destination, "taobao-example-7506-123e4567-e89b-42d3-a456-426614174000.png");
  assert.equal(screenshot?.fields.destination?.includes("/"), false);
  assert.equal(result.view.evidencePath, "/tmp/collector-work/taobao-example-7506-123e4567-e89b-42d3-a456-426614174000.png");
});

test("returns PRICE_UNSTABLE after the exact 15-second deadline", async () => {
  const client = new FakeClient();
  const defaultDetail = await fixture("item-7506-default.json");
  const cableDetail = await fixture("item-7506-cable.json");
  let sample = 0;
  client.snapshotSource = () => sample++ % 2 === 0 ? defaultDetail : cableDetail;
  let now = 0;
  const sleeps: number[] = [];
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    workDir: "/tmp/collector-work"
  });

  await assert.rejects(driver.selectSku({ 套装: "7506 + C口转换线", 转换线型号: "M1" }), (error: unknown) => {
    assert.equal(error instanceof PriceUnstableError, true);
    assert.equal((error as PriceUnstableError).code, "PRICE_UNSTABLE");
    return true;
  });
  assert.equal(now, 15_000);
  assert.equal(sleeps.every((milliseconds) => milliseconds === 250), true);
});

test("returns unavailable when a requested option becomes dynamically disabled", async () => {
  const client = new FakeClient();
  const detail = await fixture("item-7506-default.json");
  const cable = detail.children[0]!.children[2]!.children[0]!.children[1]!;
  cable.enabled = false;
  cable.actions = [];
  client.snapshotQueue.push(detail);
  const driver = new TaobaoMacDriver({ client });

  const result = await driver.selectSku({ 套装: "7506 + C口转换线" });
  assert.deepEqual(result, { availability: "UNAVAILABLE", reason: "SKU option 7506 + C口转换线 is disabled" });
  assert.equal(client.commands.some((entry) => entry.command === "perform"), false);
  assert.equal(client.commands.some((entry) => entry.command === "screenshot"), false);
});
