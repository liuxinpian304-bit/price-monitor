import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  UiContractChangedError,
  type DriverItemPage,
  type DriverSearchPosition,
  type DriverSearchResult
} from "../../core/desktop-driver.ts";
import {
  AxHelperResponseError,
  type AxHelperCommandFields,
  type AxHelperCommandName,
  type AxHelperDiagnosticPayload
} from "./ax-helper-client.ts";
import { axNodeText, fingerprintFor, walkAxNodes, type AxJsonValue, type AxNode } from "./ax-node.ts";
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

interface CommandFailure {
  command: AxHelperCommandName;
  matches?: (fields: AxHelperCommandFields) => boolean;
  error: Error;
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
  readonly snapshotQueue: Array<AxNode | Error> = [];
  readonly copiedTextQueue: string[] = [];
  readonly commandFailures: CommandFailure[] = [];
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
    if (next instanceof Error) throw next;
    this.activeRoot = structuredClone(next);
    return structuredClone(this.activeRoot);
  }

  async pressSkuOption(node: AxNode, expectedLabel: string): Promise<void> {
    await this.command("pressSkuOption", {
      nodePath: node.path,
      value: expectedLabel,
      fingerprint: fingerprintFor(node)
    });
  }

  async command<T = AxJsonValue>(command: AxHelperCommandName, fields: AxHelperCommandFields = {}): Promise<T> {
    this.commands.push({ command, fields: structuredClone(fields) });
    const failureIndex = this.commandFailures.findIndex((failure) =>
      failure.command === command && (failure.matches?.(fields) ?? true));
    if (failureIndex >= 0) {
      throw this.commandFailures.splice(failureIndex, 1)[0]!.error;
    }
    if (["setValue", "replaceText", "perform", "pressSkuOption", "captureCopiedText"].includes(command)) {
      this.assertRawTarget(command, fields);
    }
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
    if (command === "pressSkuOption") {
      const expected = fields.value?.trim().replace(/\s+/g, " ");
      const matches = walkAxNodes(node).slice(1).filter((candidate) =>
        axNodeText(candidate)?.trim().replace(/\s+/g, " ") === expected);
      if (!expected || matches.length !== 1) {
        throw new UiContractChangedError("Fake helper rejected ambiguous SKU option evidence.");
      }
    }
  }
}

function stable(root: AxNode): AxNode[] {
  return [root, root, root];
}

function missingNodeError(): AxHelperResponseError {
  return new AxHelperResponseError(
    "NODE_NOT_FOUND",
    "Accessibility node was not found."
  );
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

function withLivePagination(source: AxNode, currentPage: number, totalPages = 8): AxNode {
  const root = structuredClone(source);
  const area = walkAxNodes(root).find((node) => node.role === "AXWebArea"
    && node.url?.startsWith("https://s.taobao.com/search")) ?? assert.fail("Search area is missing");
  const node = (overrides: Partial<AxNode>): AxNode => ({
    ...rawButton([], ""), role: "AXGroup", title: null, actions: [], ...overrides
  });
  const button = (className: string, description: string, enabled = true): AxNode => node({
    role: "AXButton", description, enabled, actions: ["AXPress"],
    domClassList: ["next-btn", "next-btn-normal", "next-medium", className, "next-pagination-item"]
  });
  const pagination = node({
    domClassList: ["next-pagination-pages"],
    children: [
      button("next-prev", `上一页，当前第${currentPage}页`, currentPage > 1),
      node({
        domClassList: ["next-pagination-list"],
        children: [button("next-current", `第${currentPage}页，共${totalPages}页`)]
      }),
      node({
        domClassList: ["next-pagination-display"],
        children: [String(currentPage), "/", String(totalPages)].map((value) =>
          node({ role: "AXStaticText", value }))
      }),
      button("next-next", `下一页，当前第${currentPage}页`, currentPage < totalPages)
    ]
  });
  const repath = (current: AxNode, path: number[]): void => {
    current.path = path;
    current.children.forEach((child, index) => repath(child, [...path, index]));
  };
  repath(pagination, [...area.path, area.children.length]);
  area.children.push(pagination);
  return root;
}

function paginationPresses(client: LiveFakeClient, direction: "next-prev" | "next-next"): CommandRecord[] {
  return client.commands.filter(({ command, fields }) => command === "perform"
    && fields.action === "AXPress"
    && Array.isArray(fields.fingerprint?.domClassList)
    && fields.fingerprint.domClassList.includes(direction));
}

function assertPaginationPress(record: CommandRecord | undefined, root: AxNode, direction: "next-prev" | "next-next"): void {
  const button = walkAxNodes(root).find((node) => node.domClassList?.includes(direction))
    ?? assert.fail("Pagination button is missing");
  assert.deepEqual(record, {
    command: "perform",
    fields: { nodePath: button.path, action: "AXPress", fingerprint: fingerprintFor(button) }
  });
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

function ownListingPosition(rank: number, platformItemId: string): DriverSearchPosition {
  return {
    rank,
    platformItemId,
    url: `https://item.taobao.com/item.htm?id=${platformItemId}`,
    shopName: "Example Audio",
    title: `RME Babyface ${platformItemId}`,
    displayPriceMinText: "999.00",
    displayPriceMaxText: "999.00",
    sponsored: false,
    capturedAt: "2026-08-29T00:00:00.000Z",
    rawEvidence: {
      source: "test",
      capturedAt: "2026-08-29T00:00:00.000Z",
      metadata: { rank }
    }
  };
}

function ownListingPage(platformItemId: string): DriverItemPage {
  return {
    platformItemId,
    url: `https://item.taobao.com/item.htm?id=${platformItemId}`,
    shopName: "Example Audio",
    title: `RME Babyface ${platformItemId}`,
    skuDimensions: [],
    rawEvidence: {
      source: "test",
      capturedAt: "2026-08-29T00:00:00.000Z",
      metadata: {}
    }
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

function withClipboardLinkPrompt(root: AxNode): AxNode {
  const clone = structuredClone(root);
  const window = clone.children[0] ?? assert.fail("Live window is missing");
  const dialogPath = [...window.path, window.children.length];
  const text = (path: number[], value: string): AxNode => ({
    ...rawButton(path, ""),
    role: "AXStaticText",
    value,
    actions: []
  });
  const button = (index: number, className: string, label: string): AxNode => ({
    ...rawButton([...dialogPath, index], ""),
    role: "AXGroup",
    domClassList: [className, "_btn_fixture"],
    children: [text([...dialogPath, index, 0], label)]
  });
  window.children.push({
    ...rawButton(dialogPath, ""),
    role: "AXGroup",
    actions: [],
    domClassList: ["dialog-container"],
    children: [
      {
        ...rawButton([...dialogPath, 0], ""),
        role: "AXGroup",
        actions: [],
        domClassList: ["_title_fixture"],
        children: [text([...dialogPath, 0, 0], "已经识别到剪贴板中的淘宝链接")]
      },
      {
        ...rawButton([...dialogPath, 1], ""),
        role: "AXGroup",
        actions: [],
        domClassList: ["_clipboardLink_fixture"],
        children: [text([...dialogPath, 1, 0], "https://detail.tmall.com/item.htm?id=clipboard-only")]
      },
      button(2, "_btnClose_fixture", "稍后再说"),
      button(3, "_btnConfirm_fixture", "直接打开")
    ]
  });
  return clone;
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

test("rejects an absent exact own listing before opening any search item", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  let openedRank: number | undefined;

  driver.search = async (): Promise<DriverSearchResult> => ({
    positions: [ownListingPosition(1, "unrelated-1")],
    terminationReason: "END_MARKER"
  });
  driver.openSearchPosition = async (position) => {
    openedRank = position.rank;
    return ownListingPage(position.platformItemId ?? assert.fail("Expected an item ID"));
  };

  await assert.rejects(
    driver.openOwnListing("https://item.taobao.com/item.htm?id=own-2", "RME Babyface"),
    (error: unknown) => error instanceof UiContractChangedError
      && error.message === "Taobao did not expose the configured own listing in the first 50 results."
  );
  assert.equal(openedRank, undefined);
});

test("opens an exact own listing as soon as it appears without paging away", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search),
    search,
    ...stable(detail)
  );

  const page = await driver.openOwnListing(
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    QUERY
  );

  assert.equal(page.platformItemId, "example-x1-a");
  assert.equal(client.commands.some(({ command }) => command === "keyPress"), false);
  assert.equal(paginationPresses(client, "next-next").length, 0);
});

test("re-snapshots and relocates an exact own card after a pre-action stale path", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  client.commandFailures.push({
    command: "perform",
    matches: (fields) => fields.fingerprint?.role === "AXLink",
    error: missingNodeError()
  });
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search),
    search,
    search,
    ...stable(detail)
  );

  const page = await driver.openOwnListing(
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    QUERY
  );

  assert.equal(page.platformItemId, "example-x1-a");
  assert.equal(client.commands.filter(({ command, fields }) =>
    command === "perform" && fields.fingerprint?.role === "AXLink").length, 2);
});

test("classifies repeated exact-own-card target drift as a profiled UI failure", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    client.commandFailures.push({
      command: "perform",
      matches: (fields) => fields.fingerprint?.role === "AXLink",
      error: missingNodeError()
    });
  }
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search),
    search,
    search
  );

  await assert.rejects(
    driver.openOwnListing(
      "https://detail.tmall.com/item.htm?id=example-x1-a",
      QUERY
    ),
    (error: unknown) => error instanceof UiContractChangedError
      && error.message === "Taobao configured own listing moved before it could be opened."
  );
  assert.equal(client.commands.filter(({ command, fields }) =>
    command === "perform" && fields.fingerprint?.role === "AXLink").length, 2);
});

test("retries a transient missing detail snapshot without pressing the item again", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const detail = await fixture("live-item-x1-default.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search),
    search,
    missingNodeError(),
    ...stable(detail)
  );

  const page = await driver.openOwnListing(
    "https://detail.tmall.com/item.htm?id=example-x1-a",
    QUERY
  );

  assert.equal(page.platformItemId, "example-x1-a");
  assert.equal(client.commands.filter(({ command, fields }) =>
    command === "perform" && fields.fingerprint?.role === "AXLink").length, 1);
});

test("dismisses the exact clipboard-link prompt before searching", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withClipboardLinkPrompt(withSearchQuery(search, "Previous Query")),
    withSearchQuery(search, "Previous Query"),
    ...postWriteThenStable(search)
  );

  const result = await driver.search(QUERY, 1);

  assert.equal(result.positions.length, 1);
  const firstPress = client.commands.find(({ command }) => command === "perform");
  assert.deepEqual(firstPress, {
    command: "perform",
    fields: {
      nodePath: [0, 1, 2],
      action: "AXPress",
      fingerprint: {
        role: "AXGroup",
        domClassList: ["_btnClose_fixture", "_btn_fixture"]
      }
    }
  });
});

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
    ["activate", undefined],
    ["setValue", ""],
    ["replaceText", QUERY],
    ["perform", "AXPress"],
    ["keyPress", 121]
  ]);
  assert.deepEqual(client.commands[1], {
    command: "setValue",
    fields: {
      nodePath: [0, 0, 0, 0],
      value: "",
      fingerprint: { role: "AXTextField" }
    }
  });
  assert.deepEqual(client.commands[2], {
    command: "replaceText",
    fields: {
      nodePath: [0, 0, 0, 0],
      value: QUERY,
      fingerprint: { role: "AXTextField" }
    }
  });
  assert.deepEqual(client.commands[3], {
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

test("accepts a stable live result when the submitted query already matches the current search", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(search, search, ...stable(search));

  const result = await driver.search(QUERY, 1);

  assert.equal(result.positions.length, 1);
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "setValue", "replaceText", "perform"]
  );
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
  assert.deepEqual(client.commands.map(({ command }) => command), ["activate", "setValue", "replaceText"]);
  assert.equal(client.commands.some(({ command, fields }) =>
    command === "keyPress" && fields.keyCode === 36), false);
});

test("does not submit when the search profile changes after replacing the query", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const liveSearch = await fixture("live-search-results.json");
  const syntheticSearch = await fixture("search-results.json");
  client.snapshotQueue.push(withSearchQuery(liveSearch, "Previous Query"), syntheticSearch);

  await assert.rejects(
    driver.search(QUERY, 1),
    (error: unknown) => error instanceof UiContractChangedError
      && error.message === "Taobao search profile changed after replacing the query."
  );
  assert.deepEqual(client.commands.map(({ command }) => command), ["activate", "setValue", "replaceText"]);
  assert.equal(client.commands.some(({ command, fields }) =>
    command === "keyPress" && fields.keyCode === 36), false);
});

test("retries a transient missing result node without resubmitting the live query", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    missingNodeError(),
    ...stable(search)
  );

  const result = await driver.search(QUERY, 1);

  assert.equal(result.positions.length, 1);
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "setValue", "replaceText", "perform"]
  );
});

test("times out persistent missing result nodes without resubmitting the live query", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    ...Array.from({ length: 61 }, missingNodeError)
  );

  await assert.rejects(
    driver.search(QUERY, 1),
    (error: unknown) => error instanceof UiContractChangedError
      && error.message === "Taobao search results did not transition and stabilize within 15 seconds."
  );
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "setValue", "replaceText", "perform"]
  );
});

test("does not retry a different helper response error while observing live results", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const fatal = new AxHelperResponseError("APP_NOT_RUNNING", "Application is not running.");
  client.snapshotQueue.push(
    withSearchQuery(search, "Previous Query"),
    search,
    fatal
  );

  await assert.rejects(driver.search(QUERY, 1), (error: unknown) => error === fatal);
  assert.deepEqual(
    client.commands.map(({ command }) => command),
    ["activate", "setValue", "replaceText", "perform"]
  );
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

for (const nextFixture of ["live-search-results.json", "live-search-results-next.json"]) {
  test(`appends every card across live pages even with duplicate evidence: ${nextFixture}`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const first = withLivePagination(await fixture("live-search-results.json"), 1);
    const second = withLivePagination(await fixture(nextFixture), 2);
    client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first),
      ...stable(second), ...Array.from({ length: 61 }, () => second));

    const result = await driver.search(QUERY, 3);

    assert.deepEqual(result.positions.map(({ rank, platformItemId }) => ({ rank, platformItemId })), [
      { rank: 1, platformItemId: "example-x1-a" },
      { rank: 2, platformItemId: "example-x1-a" },
      { rank: 3, platformItemId: "example-x1-a" }
    ]);
    assert.equal(result.terminationReason, "LIMIT_REACHED");
    assert.equal(paginationPresses(client, "next-next").length, 1);
    assertPaginationPress(client.commands.at(-1), first, "next-next");
    assert.equal(client.commands.some(({ command }) => command === "keyPress"), false);
  });
}

test("requires three stable observations of the pagination total", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const first = withLivePagination(await fixture("live-search-results.json"), 1);
  const changedTotal = withLivePagination(await fixture("live-search-results.json"), 1, 9);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), first,
    first, first, ...stable(changedTotal));

  await driver.search(QUERY, 1);

  assert.equal(client.snapshotQueue.length, 0);
});

for (const transition of ["cycle", "skipped page", "changed total", "same-page changed total", "lost pagination", "added pagination"] as const) {
  test(`rejects invalid forward pagination before accumulating ranks: ${transition}`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const search = await fixture("live-search-results.json");
    const first = transition === "added pagination" ? search : withLivePagination(search, 1);
    const changedCards = searchPageVariant(search, 9);
    const invalid = transition === "cycle" ? first
      : transition === "skipped page" ? withLivePagination(search, 3)
      : transition === "changed total" ? withLivePagination(search, 2, 9)
      : transition === "same-page changed total" ? withLivePagination(changedCards, 1, 9)
      : transition === "lost pagination" ? changedCards
      : withLivePagination(changedCards, 2);
    client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first),
      ...(transition === "cycle" ? stable(withLivePagination(search, 2)) : []), ...stable(invalid));

    await assert.rejects(driver.search(QUERY, transition === "cycle" ? 5 : 3), UiContractChangedError);

    assert.equal(paginationPresses(client, "next-next").length,
      transition === "added pagination" ? 0 : transition === "cycle" ? 2 : 1);
    assert.equal(client.snapshotQueue.length, 0);
  });
}

for (const transition of ["cycle", "skipped page"] as const) {
  test(`rejects invalid forward pagination during rank replay: ${transition}`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const search = await fixture("live-search-results.json");
    const first = withLivePagination(search, 1);
    const second = withLivePagination(search, 2);
    const third = withLivePagination(search, 3);
    const rank = transition === "cycle" ? 5 : 3;
    client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first),
      ...stable(second), ...(rank === 5 ? stable(third) : []));
    const result = await driver.search(QUERY, rank);
    const beforeOpen = client.commands.length;
    client.snapshotQueue.push(first, ...(transition === "cycle" ? stable(second) : []),
      ...stable(transition === "cycle" ? first : third), ...stable(await fixture("live-item-x1-default.json")));

    await assert.rejects(driver.openSearchPosition(result.positions[rank - 1]!), UiContractChangedError);

    const commands = client.commands.slice(beforeOpen);
    assert.equal(commands.length, transition === "cycle" ? 2 : 1);
    assertPaginationPress(commands.at(-1), transition === "cycle" ? second : first, "next-next");
    assert.equal(client.snapshotQueue.length, 3);
  });
}

for (const transition of ["skipped page", "reversed page", "same page", "changed total", "lost pagination"] as const) {
  test(`rejects invalid previous-page transitions before continuing rewind: ${transition}`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const search = await fixture("live-search-results.json");
    const first = withLivePagination(search, 1);
    const current = withLivePagination(search, 3);
    const invalid = transition === "skipped page" ? first
      : transition === "reversed page" ? withLivePagination(search, 4)
      : transition === "same page" ? withLivePagination(searchPageVariant(search, 9), 3)
      : transition === "changed total" ? withLivePagination(search, 2, 9)
      : search;
    client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first));
    const result = await driver.search(QUERY, 1);
    const beforeOpen = client.commands.length;
    client.snapshotQueue.push(current, ...stable(invalid),
      ...(transition === "skipped page" ? [] : stable(first)), ...stable(await fixture("live-item-x1-default.json")));

    await assert.rejects(driver.openSearchPosition(result.positions[0]!), UiContractChangedError);

    assert.equal(client.commands.length - beforeOpen, 1);
    assertPaginationPress(client.commands.at(-1), current, "next-prev");
    assert.equal(client.snapshotQueue.length, transition === "skipped page" ? 3 : 6);
  });
}

for (const rank of [1, 3]) {
  test(`rewinds from live page two and replays global rank ${rank} without Home`, async () => {
    const client = new LiveFakeClient();
    const driver = liveDriver(client);
    const first = withLivePagination(await fixture("live-search-results.json"), 1);
    const second = withLivePagination(await fixture("live-search-results-next.json"), 2);
    const detail = await fixture("live-item-x1-default.json");
    client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first), ...stable(second));
    const result = await driver.search(QUERY, 3);
    const position = result.positions[rank - 1] ?? assert.fail("Ranked position is missing");
    const beforeOpen = client.commands.length;
    client.snapshotQueue.push(second, ...stable(first), ...(rank === 3 ? stable(second) : []), ...stable(detail));

    const page = await driver.openSearchPosition(position);

    assert.equal(page.platformItemId, "example-x1-a");
    const commands = client.commands.slice(beforeOpen);
    assert.equal(commands.length, rank === 3 ? 3 : 2);
    assertPaginationPress(commands[0], second, "next-prev");
    if (rank === 3) assertPaginationPress(commands[1], first, "next-next");
    assert.deepEqual(commands.at(-1), {
      command: "perform",
      fields: {
        nodePath: rank === 3 ? [0, 0, 1, 0, 0] : [0, 0, 1, 0, 0, 0],
        action: "AXPress",
        fingerprint: { role: "AXLink", title: QUERY }
      }
    });
    assert.equal(client.snapshotQueue.length, 0);
  });
}

test("rejects a live previous-page action that never changes the stable context", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const first = withLivePagination(await fixture("live-search-results.json"), 1);
  const second = withLivePagination(await fixture("live-search-results.json"), 2);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first));
  const result = await driver.search(QUERY, 1);
  const beforeOpen = client.commands.length;
  client.snapshotQueue.push(second, ...Array.from({ length: 61 }, () => second));

  await assert.rejects(driver.openSearchPosition(result.positions[0]!), UiContractChangedError);

  assert.equal(client.commands.length - beforeOpen, 1);
  assertPaginationPress(client.commands.at(-1), second, "next-prev");
});

test("rejects a live next-page action that never changes the stable context", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const first = withLivePagination(await fixture("live-search-results.json"), 1);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first),
    ...Array.from({ length: 61 }, () => first));

  await assert.rejects(driver.search(QUERY, 3), UiContractChangedError);

  assert.equal(paginationPresses(client, "next-next").length, 1);
  assertPaginationPress(client.commands.at(-1), first, "next-next");
});

test("rejects live rewind after exactly 50 verified previous-page movements", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const first = withLivePagination(search, 1, 60);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first));
  const result = await driver.search(QUERY, 1);
  const beforeOpen = client.commands.length;
  client.snapshotQueue.push(withLivePagination(search, 52, 60),
    ...Array.from({ length: 50 }, (_, index) => withLivePagination(search, 51 - index, 60)).flatMap(stable));

  await assert.rejects(driver.openSearchPosition(result.positions[0]!), (error: unknown) =>
    error instanceof UiContractChangedError
      && error.message === "Taobao search could not restore the first result page.");

  assert.equal(client.commands.length - beforeOpen, 50);
  assert.equal(paginationPresses(client, "next-prev").length, 50);
  assert.equal(client.snapshotQueue.length, 0);
});

test("allows live rewind to reach the exact top on movement 50", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const first = withLivePagination(search, 1, 60);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first));
  const result = await driver.search(QUERY, 1);
  const beforeOpen = client.commands.length;
  client.snapshotQueue.push(withLivePagination(search, 51, 60),
    ...Array.from({ length: 50 }, (_, index) => withLivePagination(search, 50 - index, 60)).flatMap(stable),
    ...stable(await fixture("live-item-x1-default.json")));

  const page = await driver.openSearchPosition(result.positions[0]!);

  assert.equal(page.platformItemId, "example-x1-a");
  assert.equal(client.commands.length - beforeOpen, 51);
  assert.equal(paginationPresses(client, "next-prev").length, 50);
  assert.equal(client.commands.at(-1)?.fields.fingerprint?.role, "AXLink");
  assert.equal(client.snapshotQueue.length, 0);
});

test("refuses to open a result when page one cannot restore the exact saved signature", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const search = await fixture("live-search-results.json");
  const first = withLivePagination(search, 1);
  const second = withLivePagination(search, 2);
  const changedTop = withLivePagination(searchPageVariant(search, 9), 1);
  client.snapshotQueue.push(withSearchQuery(first, "Previous Query"), ...postWriteThenStable(first));
  const result = await driver.search(QUERY, 1);
  const beforeOpen = client.commands.length;
  client.snapshotQueue.push(second, ...stable(changedTop), ...Array.from({ length: 61 }, () => changedTop));

  await assert.rejects(driver.openSearchPosition(result.positions[0]!), UiContractChangedError);

  const commands = client.commands.slice(beforeOpen);
  assert.equal(commands.length, 2);
  assertPaginationPress(commands[0], second, "next-prev");
  assert.deepEqual(commands[1], { command: "keyPress", fields: { keyCode: 115 } });
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
  client.snapshotQueue.push(detail, bundle, bundle, bundle);

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
    }
  ]);
  assert.equal(client.snapshotQueue.length, 0);
});

test("uses the guarded native SKU press for a DOM option without advertised AXPress", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const detail = await fixture("live-dom-item-x1-default.json");
  const bundle = await fixture("live-dom-item-x1-bundle.json");
  client.snapshotQueue.push(detail, bundle, bundle, bundle);

  const result = await driver.selectSku({ "套餐": "麦克风套装" });

  assert.equal(result.availability, "AVAILABLE");
  assert.deepEqual(client.commands.filter(({ command }) => command === "pressSkuOption"), [{
    command: "pressSkuOption",
    fields: {
      nodePath: [0, 0, 0, 6, 1, 1],
      value: "麦克风套装",
      fingerprint: { role: "AXGroup", domClassList: ["valueItem--fixture"] }
    }
  }]);
  assert.equal(client.snapshotQueue.length, 0);
});

test("does not press a DOM SKU option that is already selected", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const detail = await fixture("live-dom-item-x1-default.json");
  client.snapshotQueue.push(detail, detail, detail);

  const result = await driver.selectSku({ "套餐": "单机" });

  assert.equal(result.availability, "AVAILABLE");
  assert.equal(client.commands.some(({ command }) => command === "pressSkuOption" || command === "perform"), false);
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
    client.snapshotQueue.push(detail, first, second, first, second, second, second);

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

test("returns through the current decorated search tab backed by the exact search page", async () => {
  const client = new LiveFakeClient();
  const driver = liveDriver(client);
  const { search, detail } = await openDefaultDetail(client, driver);
  const searchArea = walkAxNodes(search).find((node) =>
    node.role === "AXWebArea" && node.url?.startsWith("https://s.taobao.com/search?"));
  assert.ok(searchArea);
  searchArea.title = `${QUERY}_淘宝搜索`;
  detailWindow(detail).children.push(structuredClone(searchArea));
  exactQueryTab(detail).title = `\uE71F ${QUERY}_淘宝搜索 \uE71C`;
  client.snapshotQueue.push(detail, ...stable(search));

  await driver.returnToSearch();

  assert.deepEqual(client.commands.at(-1), {
    command: "perform",
    fields: {
      nodePath: [0, 1],
      action: "AXPress",
      fingerprint: { role: "AXButton", title: `\uE71F ${QUERY}_淘宝搜索 \uE71C` }
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
