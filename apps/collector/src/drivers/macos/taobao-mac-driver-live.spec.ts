import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { UiContractChangedError } from "../../core/desktop-driver.ts";
import type { AxHelperCommandFields, AxHelperCommandName, AxHelperDiagnosticPayload } from "./ax-helper-client.ts";
import { walkAxNodes, type AxJsonValue, type AxNode } from "./ax-node.ts";
import { TaobaoMacDriver, type TaobaoAxClient } from "./taobao-mac-driver.ts";

const QUERY = "Example Interface X1";

async function fixture(name: string): Promise<AxNode> {
  const url = new URL(`../../../test/fixtures/ax/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as AxNode;
}

interface CommandRecord {
  command: AxHelperCommandName;
  fields: AxHelperCommandFields;
}

function resolvePath(root: AxNode, path: number[]): AxNode {
  let current = root;
  for (const index of path) {
    const child = current.children[index];
    if (!child) throw new UiContractChangedError("Fake helper rejected a stale accessibility path.");
    current = child;
  }
  return current;
}

class LiveFakeClient implements TaobaoAxClient {
  readonly commands: CommandRecord[] = [];
  readonly snapshotQueue: AxNode[] = [];
  copiedText: string | null = null;
  private activeRoot: AxNode | null = null;

  async diagnose(): Promise<AxHelperDiagnosticPayload> {
    return {
      appInstalled: true,
      trusted: true,
      screenRecordingTrusted: true,
      appRunning: true,
      pid: 321,
      bundleId: "com.taobao.pcdesktop",
      shortVersion: "2.4.5",
      build: "15",
      frontWindowAvailable: true
    };
  }

  async snapshot(): Promise<AxNode> {
    const next = this.snapshotQueue.shift();
    if (!next) throw new Error("Fake snapshot queue is empty");
    this.activeRoot = structuredClone(next);
    return structuredClone(this.activeRoot);
  }

  async command<T = AxJsonValue>(command: AxHelperCommandName, fields: AxHelperCommandFields = {}): Promise<T> {
    this.commands.push({ command, fields: structuredClone(fields) });
    if (["setValue", "perform", "captureCopiedText"].includes(command)) this.assertRawTarget(command, fields);
    if (command === "captureCopiedText") {
      if (this.copiedText === null) throw new Error("Copied text was not explicitly configured for this test");
      return { text: this.copiedText } as T;
    }
    return { performed: true } as T;
  }

  private assertRawTarget(command: AxHelperCommandName, fields: AxHelperCommandFields): void {
    if (!this.activeRoot || !fields.nodePath) {
      throw new UiContractChangedError("Fake helper requires a current raw accessibility target.");
    }
    const node = resolvePath(this.activeRoot, fields.nodePath);
    const fingerprint = fields.fingerprint;
    if ((fingerprint?.role !== undefined && fingerprint.role !== node.role)
      || (fingerprint?.title !== undefined && fingerprint.title !== node.title)
      || (fingerprint?.identifier !== undefined && fingerprint.identifier !== node.identifier)) {
      throw new UiContractChangedError("Fake helper rejected a changed accessibility fingerprint.");
    }
    if ((command === "perform" || command === "captureCopiedText")
      && (!fields.action || !node.actions.includes(fields.action))) {
      throw new UiContractChangedError("Fake helper rejected an unsupported accessibility action.");
    }
  }
}

function stable(root: AxNode): AxNode[] {
  return [root, root, root];
}

function withSearchQuery(root: AxNode, query: string): AxNode {
  const clone = structuredClone(root);
  const searchArea = walkAxNodes(clone).find((node) => node.role === "AXWebArea" && node.url?.startsWith("https://s.taobao.com/search"));
  const searchField = walkAxNodes(clone).find((node) => node.role === "AXTextField" && node.description === "请输入搜索文字");
  assert.ok(searchArea);
  assert.ok(searchField);
  searchArea.url = `https://s.taobao.com/search?q=${encodeURIComponent(query)}`;
  searchField.value = query;
  return clone;
}

function liveDriver(client: LiveFakeClient): TaobaoMacDriver {
  let now = 0;
  return new TaobaoMacDriver({
    client,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    capturedAt: () => "2026-08-29T00:00:00.000Z",
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    workDir: "/tmp/collector-work"
  });
}

function rawButton(path: number[], title: string): AxNode {
  return {
    path,
    role: "AXButton",
    subrole: null,
    identifier: null,
    title,
    description: null,
    value: null,
    url: null,
    enabled: true,
    selected: null,
    position: null,
    size: null,
    actions: ["AXPress"],
    children: []
  };
}

function detailWindow(root: AxNode): AxNode {
  return root.children[0] ?? assert.fail("Live detail window is missing");
}

function exactQueryTab(root: AxNode): AxNode {
  return detailWindow(root).children.find((node) => node.role === "AXButton" && node.title === QUERY)
    ?? assert.fail("Exact-query tab is missing");
}

async function searchOnce(client: LiveFakeClient, driver: TaobaoMacDriver): Promise<Awaited<ReturnType<TaobaoMacDriver["search"]>>> {
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...stable(search));
  return driver.search(QUERY, 1);
}

async function openDefaultDetail(client: LiveFakeClient, driver: TaobaoMacDriver): Promise<{ search: AxNode; detail: AxNode }> {
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  const position = result.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));
  await driver.openSearchPosition(position);
  return { search, detail };
}

test("pages a live search with Page Down and preserves duplicate and sponsored ranks", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const next = await fixture("live-search-results-next.json");
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...stable(search), ...stable(next));

  const result = await driver.search(QUERY, 3);

  assert.deepEqual(result.positions.map(({ rank, platformItemId, sponsored }) => ({ rank, platformItemId, sponsored })), [
    { rank: 1, platformItemId: "example-x1-a", sponsored: false },
    { rank: 2, platformItemId: "example-x1-a", sponsored: false },
    { rank: 3, platformItemId: "example-x1-b", sponsored: true }
  ]);
  assert.deepEqual(client.commands.map(({ command, fields }) => [command, fields.keyCode ?? fields.value]), [
    ["setValue", QUERY],
    ["keyPress", 36],
    ["keyPress", 121]
  ]);
});

test("rejects Page Down when the stable live search signature does not change", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...stable(search),
    ...Array.from({ length: 61 }, () => search)
  );

  await assert.rejects(driver.search(QUERY, 3), UiContractChangedError);
  assert.equal(client.commands.some(({ command, fields }) => command === "keyPress" && fields.keyCode === 121), true);
});

test("opens a live position with the exact raw path and no invented identifier fingerprint", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  const position = result.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));

  const page = await driver.openSearchPosition(position);

  assert.equal(page.platformItemId, "example-x1-a");
  const press = client.commands.find(({ command }) => command === "perform");
  assert.deepEqual(press, {
    command: "perform",
    fields: {
      nodePath: [0, 0, 1, 0, 0, 0],
      action: "AXPress",
      fingerprint: { role: "AXLink", title: QUERY }
    }
  });
  assert.equal(Object.hasOwn(press?.fields.fingerprint ?? {}, "identifier"), false);
});

test("presses raw live SKU nodes, re-snapshots, and returns stable bundle evidence", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const detail = await fixture("live-item-x1-default.json");
  const bundle = await fixture("live-item-x1-bundle.json");
  client.snapshotQueue.push(detail, bundle, bundle, bundle, bundle);

  const result = await driver.selectSku({ 套餐: "麦克风套装", 颜色: "黑色" });

  assert.equal(result.availability, "AVAILABLE");
  if (result.availability !== "AVAILABLE") return;
  assert.deepEqual(result.view.selectedLabels, { 套餐: "麦克风套装", 颜色: "黑色" });
  assert.equal(result.view.listPriceText, "899.00");
  assert.equal(result.view.activityPriceText, "899.00");
  assert.equal(result.view.stockState, "OUT_OF_STOCK");
  assert.deepEqual(client.commands.filter(({ command }) => command === "perform"), [
    {
      command: "perform",
      fields: {
        nodePath: [0, 0, 0, 3, 1, 1],
        action: "AXPress",
        fingerprint: { role: "AXRadioButton", title: "麦克风套装" }
      }
    },
    {
      command: "perform",
      fields: {
        nodePath: [0, 0, 0, 4, 1, 1],
        action: "AXPress",
        fingerprint: { role: "AXButton", title: "黑色" }
      }
    }
  ]);
  assert.equal(client.snapshotQueue.length, 0);
});

test("returns through the unique exact-query raw tab and waits for the exact search signature", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { search, detail } = await openDefaultDetail(client, driver);
  client.snapshotQueue.push(detail, ...stable(search));

  await driver.returnToSearch();

  assert.deepEqual(client.commands.at(-1), {
    command: "perform",
    fields: {
      nodePath: [0, 1],
      action: "AXPress",
      fingerprint: { role: "AXButton", title: QUERY }
    }
  });
  assert.equal(client.snapshotQueue.length, 0);
});

test("uses one raw 返回 button only when no exact-query live tab exists", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { search, detail } = await openDefaultDetail(client, driver);
  exactQueryTab(detail).title = "Other Query";
  detailWindow(detail).children.push(rawButton([0, 2], "返回"));
  client.snapshotQueue.push(detail, ...stable(search));

  await driver.returnToSearch();

  assert.deepEqual(client.commands.at(-1)?.fields.nodePath, [0, 2]);
});

test("rejects multiple exact-query live tabs", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { detail } = await openDefaultDetail(client, driver);
  const duplicate = structuredClone(exactQueryTab(detail));
  duplicate.path = [0, 2];
  detailWindow(detail).children.push(duplicate);
  client.snapshotQueue.push(detail);

  await assert.rejects(driver.returnToSearch(), UiContractChangedError);
});

test("rejects multiple 返回 buttons when no exact-query live tab exists", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { detail } = await openDefaultDetail(client, driver);
  exactQueryTab(detail).title = "Other Query";
  detailWindow(detail).children.push(rawButton([0, 2], "返回"), rawButton([0, 3], "返回"));
  client.snapshotQueue.push(detail);

  await assert.rejects(driver.returnToSearch(), UiContractChangedError);
});

test("rejects a stale raw exact-query tab path", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { detail } = await openDefaultDetail(client, driver);
  exactQueryTab(detail).path = [0, 99];
  client.snapshotQueue.push(detail);

  await assert.rejects(driver.returnToSearch(), UiContractChangedError);
});

test("rejects a live detail whose item ID changed after opening", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  const detailArea = walkAxNodes(detail).find((node) => node.role === "AXWebArea" && node.title === "商品详情");
  assert.ok(detailArea);
  detailArea.url = "https://detail.tmall.com/item.htm?id=example-x1-changed";
  const position = result.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));

  await assert.rejects(driver.openSearchPosition(position), UiContractChangedError);
});
