import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LoginRequiredError,
  PlatformChallengeError,
  UiContractChangedError,
  type DriverSearchPosition
} from "../../core/desktop-driver.ts";
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

function searchContainer(root: AxNode): AxNode {
  const container = root.children[0]?.children.find((node) => node.identifier === "search-result-list");
  assert.ok(container);
  return container;
}

function resultQueryMarker(root: AxNode): AxNode {
  const marker = searchContainer(root).children.find((node) => node.identifier === "search-result-query-marker");
  assert.ok(marker);
  return marker;
}

function withResultQuery(root: AxNode, query: string): AxNode {
  const clone = structuredClone(root);
  resultQueryMarker(clone).value = query;
  return clone;
}

function emptySearchResults(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const marker = resultQueryMarker(clone);
  searchContainer(clone).children = [marker];
  return clone;
}

function blankSearchPage(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const window = clone.children[0];
  assert.ok(window);
  window.children = window.children.filter((node) => node.identifier === "search-region");
  return clone;
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
  client.snapshotQueue.push(withResultQuery(search, "旧查询"), search, search, search);
  const driver = new TaobaoMacDriver({ client, capturedAt: () => "2026-08-24T00:00:00.000Z" });

  const results = await driver.search("索尼 7506", 3);
  assert.deepEqual(results.map((entry) => [entry.rank, entry.platformItemId]), [
    [1, "example-7506"], [2, "example-7506"], [3, null]
  ]);
  assert.deepEqual(client.commands.map((entry) => entry.command), ["setValue", "keyPress"]);
  assert.equal(client.commands[0]?.fields.value, "索尼 7506");
  assert.equal(client.commands[1]?.fields.keyCode, 36);
});

test("rejects the pre-submit stale list until the result query context transitions and stabilizes", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const stale = withResultQuery(search, "旧查询");
  const staleLink = searchContainer(stale).children
    .find((node) => node.identifier === "result-card")?.children
    .find((node) => node.identifier === "item-link");
  assert.ok(staleLink);
  staleLink.title = "旧结果";
  client.snapshotQueue.push(stale, stale, search, search, search);
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });

  const results = await driver.search("索尼 7506", 1);
  assert.equal(results[0]?.title, "Sony MDR-7506 监听耳机");
  assert.deepEqual(sleeps, [250, 250, 250]);
});

test("accepts repeated-query results after a loading miss latches the submit transition", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const loading = blankSearchPage(search);
  client.snapshotQueue.push(
    search,
    loading,
    search, search, search,
    ...Array.from({ length: 58 }, () => search)
  );
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });

  const results = await driver.search("索尼 7506", 3);
  assert.equal(results.length, 3);
  assert.deepEqual(sleeps, [250, 250, 250]);
});

test("starts a search from a blank page without a pre-submit result context", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  client.snapshotQueue.push(blankSearchPage(search), search, search, search);
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });

  const results = await driver.search("索尼 7506", 3);
  assert.equal(results.length, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

test("times out when repeated-query results never show a post-submit transition", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  client.snapshotQueue.push(search, ...Array.from({ length: 61 }, () => search));
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });

  await assert.rejects(driver.search("索尼 7506", 3), UiContractChangedError);
  assert.equal(now, 15_000);
  assert.equal(sleeps.length, 60);
  assert.equal(sleeps.every((milliseconds) => milliseconds === 250), true);
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

test("tolerates transitional search and empty snapshots while detail stabilizes", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const empty = structuredClone(search);
  empty.children = [];
  const detail = await fixture("item-7506-default.json");
  client.snapshotQueue.push(search, search, empty, detail, detail, detail);
  const sleeps: number[] = [];
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });

  const page = await driver.openSearchPosition(position());
  assert.equal(page.platformItemId, "example-7506");
  assert.deepEqual(sleeps, [250, 250, 250, 250]);
});

test("propagates a login stop immediately during a detail transition", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const login = await fixture("login-required.json");
  client.snapshotQueue.push(search, login);
  const sleeps: number[] = [];
  const driver = new TaobaoMacDriver({
    client,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });

  await assert.rejects(driver.openSearchPosition(position()), LoginRequiredError);
  assert.deepEqual(sleeps, []);
});

test("propagates a challenge stop immediately during a detail transition", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const challenge = await fixture("platform-challenge.json");
  client.snapshotQueue.push(search, challenge);
  const sleeps: number[] = [];
  const driver = new TaobaoMacDriver({
    client,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });

  await assert.rejects(driver.openSearchPosition(position()), PlatformChallengeError);
  assert.deepEqual(sleeps, []);
});

test("assigns a new rank to an identical card with a distinct AX occurrence after scrolling", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const before = structuredClone(search);
  const beforeContainer = searchContainer(before);
  const marker = resultQueryMarker(before);
  const firstCard = beforeContainer.children.find((node) => node.identifier === "result-card");
  assert.ok(firstCard);
  beforeContainer.children = [marker, firstCard];
  const boundary = await fixture("search-results-duplicate-boundary.json");
  client.snapshotQueue.push(
    withResultQuery(before, "旧查询"),
    before, before, before,
    boundary, boundary, boundary
  );
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  const results = await driver.search("索尼 7506", 2);
  assert.deepEqual(results.map((entry) => [entry.rank, entry.platformItemId]), [
    [1, "example-7506"], [2, "example-7506"]
  ]);
  assert.equal(client.commands.filter((entry) => entry.command === "perform").length, 1);
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

test("rejects stable selected-SKU observations from a different item", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const defaultDetail = await fixture("item-7506-default.json");
  const wrongCableDetail = await fixture("item-7506-cable.json");
  wrongCableDetail.children[0]!.url = "https://item.example.test/item.htm?id=different-item";
  client.snapshotQueue.push(
    search,
    defaultDetail, defaultDetail, defaultDetail,
    defaultDetail, wrongCableDetail, wrongCableDetail, wrongCableDetail, wrongCableDetail
  );
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    workDir: "/tmp/collector-work"
  });

  await driver.openSearchPosition(position());
  await assert.rejects(
    driver.selectSku({ 套装: "7506 + C口转换线", 转换线型号: "M1" }),
    UiContractChangedError
  );
  assert.equal(client.commands.some((entry) => entry.command === "screenshot"), false);
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

test("waits through unrelated and empty results until the original search context is restored", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const detail = await fixture("item-7506-default.json");
  const unrelated = structuredClone(search);
  const unrelatedLink = searchContainer(unrelated).children
    .find((node) => node.identifier === "result-card")?.children
    .find((node) => node.identifier === "item-link");
  assert.ok(unrelatedLink);
  unrelatedLink.title = "无关商品";
  const empty = emptySearchResults(search);
  client.snapshotQueue.push(
    withResultQuery(search, "旧查询"), search, search, search,
    search, detail, detail, detail,
    detail, unrelated, empty, search, search, search
  );
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  await driver.search("索尼 7506", 3);
  await driver.openSearchPosition(position());
  await driver.returnToSearch();
  assert.equal(client.snapshotQueue.length, 0);
  assert.equal(client.commands.at(-1)?.command, "perform");
});

test("rejects a stable unrelated result list after accessible back", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const detail = await fixture("item-7506-default.json");
  const unrelated = structuredClone(search);
  for (const card of searchContainer(unrelated).children.filter((node) => node.identifier === "result-card")) {
    const link = card.children.find((node) => node.identifier === "item-link");
    assert.ok(link);
    link.title = `无关商品 ${card.path.join(".")}`;
  }
  client.snapshotQueue.push(
    withResultQuery(search, "旧查询"), search, search, search,
    search, detail, detail, detail,
    detail,
    ...Array.from({ length: 61 }, () => unrelated)
  );
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  await driver.search("索尼 7506", 3);
  await driver.openSearchPosition(position());
  const beforeBack = now;
  await assert.rejects(driver.returnToSearch(), UiContractChangedError);
  assert.equal(now - beforeBack, 15_000);
});

test("rejects a stable empty result list after accessible back", async () => {
  const client = new FakeClient();
  const search = await fixture("search-results.json");
  const detail = await fixture("item-7506-default.json");
  const empty = emptySearchResults(search);
  client.snapshotQueue.push(
    withResultQuery(search, "旧查询"), search, search, search,
    search, detail, detail, detail,
    detail,
    ...Array.from({ length: 61 }, () => empty)
  );
  let now = 0;
  const driver = new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  await driver.search("索尼 7506", 3);
  await driver.openSearchPosition(position());
  const beforeBack = now;
  await assert.rejects(driver.returnToSearch(), UiContractChangedError);
  assert.equal(now - beforeBack, 15_000);
});
