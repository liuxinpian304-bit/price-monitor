import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { UiContractChangedError, type DriverSearchPosition } from "../../core/desktop-driver.ts";
import type { AxHelperCommandFields, AxHelperCommandName, AxHelperDiagnosticPayload } from "./ax-helper-client.ts";
import { fingerprintFor, walkAxNodes, type AxJsonValue, type AxNode } from "./ax-node.ts";
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
  readonly copiedTextQueue: string[] = [];
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
      const copiedText = this.copiedTextQueue.shift() ?? this.copiedText;
      if (copiedText === null) throw new Error("Copied text was not explicitly configured for this test");
      return { text: copiedText } as T;
    }
    return { performed: true } as T;
  }

  private assertRawTarget(command: AxHelperCommandName, fields: AxHelperCommandFields): void {
    if (!this.activeRoot || !fields.nodePath) {
      throw new UiContractChangedError("Fake helper requires a current raw accessibility target.");
    }
    const node = resolvePath(this.activeRoot, fields.nodePath);
    if (!isDeepStrictEqual(fields.fingerprint, fingerprintFor(node))) {
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

function postWriteThenStable(root: AxNode): AxNode[] {
  return [root, ...stable(root)];
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

function searchResultRegion(root: AxNode): AxNode {
  return walkAxNodes(root).find((node) => node.description === "搜索结果")
    ?? assert.fail("Live search result region is missing");
}

function searchPageVariant(root: AxNode, page: number): AxNode {
  const clone = structuredClone(root);
  const region = searchResultRegion(clone);
  region.children.forEach((card, cardIndex) => {
    const itemId = `page-${page}-${cardIndex}`;
    for (const node of walkAxNodes(card)) {
      if (node.role === "AXLink") {
        node.title = `${QUERY} ${itemId}`;
        node.url = `https://detail.tmall.com/item.htm?id=${itemId}`;
      }
      if (node.description === "店铺") node.value = `Example Audio ${itemId}`;
      if (node.description === "价格") node.value = `${700 + page}.${String(cardIndex).padStart(2, "0")}`;
    }
  });
  return clone;
}

function withRawSearchAdvance(root: AxNode): AxNode {
  const clone = structuredClone(root);
  searchResultRegion(clone).actions.push("AXScrollDown");
  return clone;
}

function withoutFirstCardIdentity(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const firstCard = searchResultRegion(clone).children[0] ?? assert.fail("First live search card is missing");
  for (const link of walkAxNodes(firstCard).filter((node) => node.role === "AXLink")) {
    link.url = "https://detail.tmall.com/item.htm";
  }
  return clone;
}

function sponsoredFirstCard(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const firstCard = searchResultRegion(clone).children[0] ?? assert.fail("First live search card is missing");
  for (const link of walkAxNodes(firstCard).filter((node) => node.role === "AXLink")) {
    link.url = "https://click.simba.taobao.com/auction?tracking=overlap-probe&id=example-x1-a";
  }
  return clone;
}

function unreachablePosition(base: DriverSearchPosition, rank: number): DriverSearchPosition {
  return {
    ...base,
    rank,
    platformItemId: "example-x1-unreachable",
    url: "https://detail.tmall.com/item.htm?id=example-x1-unreachable",
    title: "Example Interface X1 Unreachable",
    shopName: "Example Audio Unreachable",
    displayPriceMinText: "999.00",
    displayPriceMaxText: "999.00",
    sponsored: false
  };
}

function withoutDetailIdentity(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const detailArea = walkAxNodes(clone).find((node) => node.role === "AXWebArea" && node.title === "商品详情");
  assert.ok(detailArea);
  detailArea.url = "https://detail.tmall.com/item.htm";
  return clone;
}

function withSelectedSkuEvidence(root: AxNode, description: string, value: string): AxNode {
  const clone = structuredClone(root);
  const matches = walkAxNodes(clone).filter((node) => node.description === description);
  assert.equal(matches.length, 1, `Expected one ${description} evidence node`);
  matches[0]!.value = value;
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
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search));
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
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search), ...stable(next));

  const result = await driver.search(QUERY, 3);

  assert.deepEqual(result.positions.map(({ rank, platformItemId, sponsored }) => ({ rank, platformItemId, sponsored })), [
    { rank: 1, platformItemId: "example-x1-a", sponsored: false },
    { rank: 2, platformItemId: "example-x1-a", sponsored: false },
    { rank: 3, platformItemId: "example-x1-b", sponsored: true }
  ]);
  assert.deepEqual(client.commands.map(({ command, fields }) => [
    command,
    fields.action ?? fields.keyCode ?? fields.value
  ]), [
    ["setValue", QUERY],
    ["perform", "AXPress"],
    ["keyPress", 121]
  ]);
  assert.deepEqual(client.commands[0], {
    command: "setValue",
    fields: {
      nodePath: [0, 0, 0, 0],
      value: QUERY,
      fingerprint: { role: "AXTextField" }
    }
  });
  assert.deepEqual(client.commands[1], {
    command: "perform",
    fields: {
      nodePath: [0, 0, 0, 1],
      action: "AXPress",
      fingerprint: { role: "AXButton", title: "搜索" }
    }
  });
  assert.equal(client.commands.some(({ command, fields }) =>
    command === "keyPress" && fields.keyCode === 36), false);
});

test("does not submit when the freshly observed search value differs from the request", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    withSearchQuery(search, "Different Query")
  );

  await assert.rejects(driver.search(QUERY, 1), UiContractChangedError);
  assert.deepEqual(client.commands.map(({ command }) => command), ["setValue"]);
});

test("uses the exact raw live AXScrollDown action before the Page Down fallback", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = withRawSearchAdvance(await fixture("live-search-results.json"));
  const next = await fixture("live-search-results-next.json");
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search), ...stable(next));

  await driver.search(QUERY, 3);

  assert.deepEqual(client.commands.at(-1), {
    command: "perform",
    fields: {
      nodePath: [0, 0, 1],
      action: "AXScrollDown",
      fingerprint: { role: "AXGroup" }
    }
  });
  assert.equal(client.commands.some(({ command, fields }) => command === "keyPress" && fields.keyCode === 121), false);
});

test("rejects Page Down when the stable live search signature does not change", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search),
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
  const press = client.commands.at(-1);
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

test("recovers an ID-less live detail through the exact raw copied-link action", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = withoutFirstCardIdentity(await fixture("live-search-results.json"));
  const detail = withoutDetailIdentity(await fixture("live-item-x1-default.json"));
  client.copiedText = "https://detail.tmall.com/item.htm?id=example-x1-a";
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search));
  const result = await driver.search(QUERY, 1);
  const position = result.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));

  const page = await driver.openSearchPosition(position);

  assert.equal(page.platformItemId, "example-x1-a");
  assert.deepEqual(client.commands.at(-1), {
    command: "captureCopiedText",
    fields: {
      nodePath: [0, 0, 0, 2],
      action: "AXPress",
      fingerprint: { role: "AXButton", title: "分享" }
    }
  });
});

test("rejects an unsupported copied link during ID-less live detail recovery", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = withoutFirstCardIdentity(await fixture("live-search-results.json"));
  const detail = withoutDetailIdentity(await fixture("live-item-x1-default.json"));
  client.copiedText = "custom://item.taobao.com/account?id=example-x1-a";
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search));
  const result = await driver.search(QUERY, 1);
  const position = result.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));

  await assert.rejects(driver.openSearchPosition(position), UiContractChangedError);
});

test("reconstructs a global duplicate rank instead of opening a sponsored same-ID overlap path", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const overlap = sponsoredFirstCard(await fixture("live-search-results-next.json"));
  const detail = await fixture("live-item-x1-default.json");
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search), ...stable(overlap));
  const result = await driver.search(QUERY, 3);
  const first = result.positions[0] ?? assert.fail("First live search position is missing");
  assert.equal(first.sponsored, false);
  assert.equal(first.url, "https://detail.tmall.com/item.htm?id=example-x1-a");
  const beforeOpen = client.commands.length;
  client.snapshotQueue.push(overlap, ...stable(search), ...stable(detail));

  await driver.openSearchPosition(first);

  assert.deepEqual(client.commands.slice(beforeOpen), [
    { command: "keyPress", fields: { keyCode: 115 } },
    {
      command: "perform",
      fields: {
        nodePath: [0, 0, 1, 0, 0, 0],
        action: "AXPress",
        fingerprint: { role: "AXLink", title: QUERY }
      }
    }
  ]);
});

test("rejects locate paging when an unparsable snapshot returns to the unchanged signature", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const offTop = searchPageVariant(search, 900);
  const unparsable = structuredClone(search);
  unparsable.children = [];
  const target = unreachablePosition(result.positions[0] ?? assert.fail("Live search position is missing"), 100);
  client.snapshotQueue.push(offTop, ...stable(search), unparsable, ...Array.from({ length: 70 }, () => search));

  await assert.rejects(driver.openSearchPosition(target), UiContractChangedError);

  const pageDowns = client.commands.filter(({ command, fields }) => command === "keyPress" && fields.keyCode === 121);
  assert.equal(pageDowns.length, 1);
});

test("rejects locate paging when a changed parseable transient settles on the original signature", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const offTop = searchPageVariant(search, 900);
  const transient = searchPageVariant(search, 901);
  const target = unreachablePosition(result.positions[0] ?? assert.fail("Live search position is missing"), 100);
  client.snapshotQueue.push(offTop, ...stable(search), transient, ...Array.from({ length: 70 }, () => search));

  await assert.rejects(driver.openSearchPosition(target), UiContractChangedError);

  const pageDowns = client.commands.filter(({ command, fields }) => command === "keyPress" && fields.keyCode === 121);
  assert.equal(pageDowns.length, 1);
});

test("attempts at most 50 search advances while recovering a ranked position", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const result = await searchOnce(client, driver);
  const search = await fixture("live-search-results.json");
  const offTop = searchPageVariant(search, 900);
  const target = unreachablePosition(result.positions[0] ?? assert.fail("Live search position is missing"), 10_000);
  const pages = Array.from({ length: 51 }, (_, index) => searchPageVariant(search, index + 1));
  client.snapshotQueue.push(offTop, ...stable(search), ...pages.flatMap(stable));

  await assert.rejects(driver.openSearchPosition(target), UiContractChangedError);

  const pageDowns = client.commands.filter(({ command, fields }) => command === "keyPress" && fields.keyCode === 121);
  assert.equal(pageDowns.length, 50);
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

test("rejects direct live item identity disappearance after a SKU action", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const detail = await fixture("live-item-x1-default.json");
  const idlessBundle = withoutDetailIdentity(await fixture("live-item-x1-bundle.json"));
  client.snapshotQueue.push(detail, idlessBundle, idlessBundle, idlessBundle, idlessBundle);

  await assert.rejects(
    driver.selectSku({ 套餐: "麦克风套装", 颜色: "黑色" }),
    UiContractChangedError
  );
});

test("requires fresh copied-link identity after ID-less live SKU actions", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = withoutFirstCardIdentity(await fixture("live-search-results.json"));
  const detail = withoutDetailIdentity(await fixture("live-item-x1-default.json"));
  const bundle = withoutDetailIdentity(await fixture("live-item-x1-bundle.json"));
  const itemUrl = "https://detail.tmall.com/item.htm?id=example-x1-a";
  client.copiedTextQueue.push(itemUrl, itemUrl);
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search));
  const searchResult = await driver.search(QUERY, 1);
  const position = searchResult.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));
  await driver.openSearchPosition(position);
  client.snapshotQueue.push(detail, bundle, bundle, bundle, bundle);

  const result = await driver.selectSku({ 套餐: "麦克风套装", 颜色: "黑色" });

  assert.equal(result.availability, "AVAILABLE");
  assert.equal(client.commands.filter(({ command }) => command === "captureCopiedText").length, 2);
});

test("rejects changed copied-link identity after ID-less live SKU actions", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = withoutFirstCardIdentity(await fixture("live-search-results.json"));
  const detail = withoutDetailIdentity(await fixture("live-item-x1-default.json"));
  const bundle = withoutDetailIdentity(await fixture("live-item-x1-bundle.json"));
  client.copiedTextQueue.push(
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    "https://detail.tmall.com/item.htm?id=example-x1-changed"
  );
  client.snapshotQueue.push(withSearchQuery(search, "Previous Query"), ...postWriteThenStable(search));
  const searchResult = await driver.search(QUERY, 1);
  const position = searchResult.positions[0] ?? assert.fail("Live search position is missing");
  client.snapshotQueue.push(search, ...stable(detail));
  await driver.openSearchPosition(position);
  client.snapshotQueue.push(detail, bundle, bundle, bundle, bundle);

  await assert.rejects(
    driver.selectSku({ 套餐: "麦克风套装", 颜色: "黑色" }),
    UiContractChangedError
  );
});

const completeSkuStabilityCases = [
  {
    name: "stock",
    description: "库存状态",
    first: "有货",
    second: "无货",
    field: "stockState",
    expected: "OUT_OF_STOCK"
  },
  {
    name: "list price",
    description: "原价",
    first: "原价 799.00",
    second: "原价 809.00",
    field: "listPriceText",
    expected: "809.00"
  },
  {
    name: "estimated payable",
    description: "预估到手价",
    first: "预估到手价 679.00",
    second: "预估到手价 689.00",
    field: "officialEstimatedPayablePriceText",
    expected: "689.00"
  },
  {
    name: "mandatory fee",
    description: "运费",
    first: "包邮",
    second: "10.00",
    field: "mandatoryFeeText",
    expected: "10.00"
  }
] as const;

for (const evidenceCase of completeSkuStabilityCases) {
  test(`requires three stable ${evidenceCase.name} observations`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const detail = await fixture("live-item-x1-default.json");
    const first = withSelectedSkuEvidence(detail, evidenceCase.description, evidenceCase.first);
    const second = withSelectedSkuEvidence(detail, evidenceCase.description, evidenceCase.second);
    client.snapshotQueue.push(detail, detail, first, second, first, second, second, second);

    const result = await driver.selectSku({ 套餐: "单机", 颜色: "银色" });

    assert.equal(result.availability, "AVAILABLE");
    if (result.availability !== "AVAILABLE") return;
    assert.equal(result.view[evidenceCase.field], evidenceCase.expected);
    assert.equal(client.snapshotQueue.length, 0);
  });
}

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

  assert.deepEqual(client.commands.at(-1), {
    command: "perform",
    fields: {
      nodePath: [0, 2],
      action: "AXPress",
      fingerprint: { role: "AXButton", title: "返回" }
    }
  });
});

test("rejects a changed live detail item before return mutation", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { search, detail } = await openDefaultDetail(client, driver);
  const changed = structuredClone(detail);
  const detailArea = walkAxNodes(changed).find((node) => node.role === "AXWebArea" && node.title === "商品详情");
  assert.ok(detailArea);
  detailArea.url = "https://detail.tmall.com/item.htm?id=example-x1-changed";
  const beforeReturn = client.commands.length;
  client.snapshotQueue.push(changed, ...stable(search));

  await assert.rejects(driver.returnToSearch(), UiContractChangedError);

  assert.equal(client.commands.length, beforeReturn);
});

test("rejects a missing raw detail identity when the opened item did not use copied-link recovery", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { search, detail } = await openDefaultDetail(client, driver);
  const beforeReturn = client.commands.length;
  client.snapshotQueue.push(withoutDetailIdentity(detail), ...stable(search));

  await assert.rejects(driver.returnToSearch(), UiContractChangedError);

  assert.equal(client.commands.length, beforeReturn);
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

test("live fake rejects a node mutation without its complete raw fingerprint", async () => {
  const client = new LiveFakeClient();
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(search);
  await client.snapshot();

  await assert.rejects(client.command("setValue", {
    nodePath: [0, 0, 0, 0],
    value: QUERY,
    fingerprint: {}
  }), UiContractChangedError);
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
