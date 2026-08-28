import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiData } from "../api/client.ts";
import { fetchCollectionEvidence, requeueCollectionRun } from "../api/collection-runs.ts";
import type { CollectionRunReportDetail } from "../api/types.ts";
import { CollectionRunDetailPage } from "./CollectionRunDetailPage.tsx";

vi.mock("../api/client.ts", () => ({ useApiData: vi.fn() }));
vi.mock("../api/collection-runs.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/collection-runs.ts")>(),
  fetchCollectionEvidence: vi.fn(),
  requeueCollectionRun: vi.fn()
}));

const prices = {
  listPriceFen: 69_800,
  activityPriceFen: 67_900,
  couponDiscountFen: 1_000,
  fullReductionFen: 0,
  directDiscountFen: 0,
  mandatoryFeeFen: 0,
  publicDiscountFen: 1_000,
  payableFen: 66_900
};

const selectedOwnSnapshot = {
  id: "own-selected",
  ownListingId: "listing-selected",
  platformItemId: "own-1",
  skuId: "own-standard",
  shopName: "我方旗舰店",
  title: "Sony MDR-7506",
  skuText: "黑色 / 标准版",
  url: "https://detail.tmall.com/item.htm?id=own-selected",
  attributes: { color: "黑色" },
  components: [{ role: "CORE" as const, accessoryType: "HEADPHONE", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 }],
  promotions: [],
  gifts: [],
  prices: { ...prices, activityPriceFen: 69_000, couponDiscountFen: 0, publicDiscountFen: 0, payableFen: 69_000 },
  stockState: "IN_STOCK" as const,
  confidence: "CONFIRMED" as const,
  combinationSignature: "sony-7506-black",
  combinationLabel: "黑色 / 标准版"
};

const alternativeOwnSnapshot = {
  ...selectedOwnSnapshot,
  id: "own-alternative",
  ownListingId: "listing-alternative",
  platformItemId: "own-2",
  skuId: "own-alt",
  skuText: "黑色 / 标准版（备用链接）",
  url: "https://detail.tmall.com/item.htm?id=own-alternative",
  prices: { ...selectedOwnSnapshot.prices, payableFen: 70_000 }
};

const competitorBusinessSku = {
  id: "competitor-business-sku",
  source: "COMPETITOR" as const,
  platformItemId: "item-1",
  skuId: "competitor-standard",
  shopName: "索尼聚鑫数码商城",
  title: "Sony MDR-7506 监听耳机",
  skuText: "黑色 / 标准版",
  url: "https://item.taobao.com/item.htm?id=competitor-business",
  ranks: [1, 4],
  positions: [
    { rank: 1, platformItemId: "item-1", url: "https://item.taobao.com/item.htm?id=competitor-business", shopName: "索尼聚鑫数码商城", title: "Sony MDR-7506 监听耳机", displayPriceMinFen: 66_900, displayPriceMaxFen: 67_900, sponsored: false, capturedAt: "2026-08-25T01:30:00.000Z" },
    { rank: 4, platformItemId: "item-1", url: "https://item.taobao.com/item.htm?id=competitor-business", shopName: "索尼聚鑫数码商城", title: "Sony MDR-7506 监听耳机", displayPriceMinFen: 66_900, displayPriceMaxFen: 67_900, sponsored: true, capturedAt: "2026-08-25T01:30:05.000Z" }
  ],
  attributes: { color: "黑色" },
  components: [{ role: "CORE" as const, accessoryType: "HEADPHONE", brand: "Sony", modelOrName: "MDR-7506", quantity: 1 }],
  promotions: [{ kind: "COUPON", label: "店铺券 ¥10", amountFen: 1_000, thresholdFen: null, audience: "PUBLIC", stackGroup: null, includedInActivityPrice: false, activityPriceInclusion: "EXCLUDED" as const }],
  gifts: [],
  prices,
  stockState: "IN_STOCK" as const,
  confidence: "CONFIRMED" as const,
  match: { category: "EXACT" as const, decision: "BARE" as const, comparable: true, confidenceBps: 10_000, reasons: ["型号与组合一致"] },
  combination: { state: "MATCHED" as const, signature: "sony-7506-black", label: "黑色 / 标准版", reasons: [] },
  selectedOwnSnapshot,
  alternativeOwnSnapshots: [alternativeOwnSnapshot],
  differenceFen: 2_100,
  comparison: { state: "LOWER" as const, ownPayableFen: 69_000, differenceFen: 2_100 },
  evidenceSha256: "c".repeat(64),
  capturedAt: "2026-08-25T01:30:10.000Z"
};

const missingBusinessSku = {
  ...competitorBusinessSku,
  id: "missing-business-sku",
  platformItemId: "item-missing",
  skuId: "missing-white",
  shopName: "同行缺货对照店",
  title: "Sony MDR-7506 白色套装",
  skuText: "白色 / 收纳包套装",
  url: "https://item.taobao.com/item.htm?id=missing-business",
  ranks: [8],
  positions: [],
  combination: { state: "MISSING_OWN" as const, signature: "sony-7506-white-kit", label: "白色 / 收纳包套装", reasons: ["OWN_COMBINATION_ABSENT"] },
  selectedOwnSnapshot: null,
  alternativeOwnSnapshots: [],
  differenceFen: null,
  comparison: { state: "UNDECIDED" as const, ownPayableFen: null, differenceFen: null }
};

function report(status: string): CollectionRunReportDetail {
  return {
    id: "run-1",
    status,
    provider: "taobao-desktop",
    scheduledFor: "2026-08-25T01:30:00.000Z",
    startedAt: "2026-08-25T01:30:10.000Z",
    finishedAt: null,
    model: { id: "model-1", monitorCode: "SONY-7506", label: "Sony MDR-7506", comparisonType: "BARE", owner: "运营A" },
    collector: { id: "agent-1", name: "mac-studio-1", platform: "MACOS", appVersion: "2.4.5" },
    completion: { positionsCaptured: 47, requestedPositions: 50, discoveredCount: 47, fetchedCount: 47, matchedCount: 2, failedCount: 3, uniqueItemCount: 47, skuCount: 2, incompleteCount: 3, terminationReason: null, complete: false, label: "47 / 50，未完成" },
    notification: { state: "FAILED", attempts: 2, notifiedAt: null, lastError: "WECOM_DELIVERY_FAILED" },
    error: { code: "LOGIN_REQUIRED", message: "淘宝登录已失效" },
    businessSummary: { distinctShopCount: 2, distinctItemCount: 2, skuCount: 3, matchedSkuCount: 1, confirmedLowCount: 1, missingCombinationCount: 2, reviewCount: 1, excludedCount: 0, ownConfiguredListingCount: 3, ownCollectedListingCount: 2, ownCatalogComplete: false },
    priceBoard: {
      shops: [{
        shopName: "索尼聚鑫数码商城", earliestRank: 1, ranks: [1, 4, 7], positionCount: 3, itemCount: 2, skuCount: 1,
        minimumConfirmedPayableFen: 66_900, confirmedLowCount: 1, missingCombinationCount: 0,
        items: [
          { platformItemId: "item-1", shopName: "索尼聚鑫数码商城", title: "Sony MDR-7506 监听耳机", url: "https://item.taobao.com/item.htm?id=competitor-business", earliestRank: 1, ranks: [1, 4], positions: competitorBusinessSku.positions, skuCount: 1, skus: [competitorBusinessSku] },
          { platformItemId: "item-empty", shopName: "索尼聚鑫数码商城", title: "Sony MDR-7506 待补采商品", url: "https://item.taobao.com/item.htm?id=empty-item", earliestRank: 7, ranks: [7], positions: [], skuCount: 0, skus: [] }
        ]
      }]
    },
    confirmedLows: [{ competitorSnapshot: competitorBusinessSku, selectedOwnSnapshot, alternativeOwnSnapshots: [alternativeOwnSnapshot], combinationSignature: "sony-7506-black", combinationLabel: "黑色 / 标准版", differenceFen: 2_100, ranks: [1, 4], reasons: ["CONFIRMED_LOWER"] }],
    missingOwnGroups: [
      { combinationSignature: "sony-7506-white-kit", combinationLabel: "白色 / 收纳包套装", missingReason: "OWN_COMBINATION_ABSENT", earliestRank: 8, minimumConfirmedPayableFen: 66_900, minimumOfferSnapshotId: "missing-business-sku", minimumOfferRank: 8, shops: ["同行缺货对照店"], offers: [missingBusinessSku] },
      { combinationSignature: "sony-7506-blue", combinationLabel: "蓝色 / 标准版", missingReason: "OWN_OUT_OF_STOCK_ONLY", earliestRank: 12, minimumConfirmedPayableFen: null, minimumOfferSnapshotId: null, minimumOfferRank: null, shops: ["同行库存店"], offers: [{ ...missingBusinessSku, id: "out-of-stock-business-sku", shopName: "同行库存店", skuText: "蓝色 / 标准版", ranks: [12], prices: { ...prices, payableFen: null } }] }
    ],
    reviewRows: [{ ...competitorBusinessSku, id: "review-business-sku", combination: { state: "REVIEW", signature: null, label: null, reasons: ["MANUAL_REVIEW"] }, selectedOwnSnapshot: null, alternativeOwnSnapshots: [], differenceFen: null, comparison: { state: "UNDECIDED", ownPayableFen: null, differenceFen: null } }],
    positions: [{ rank: 1, platformItemId: "item-1", url: "https://item.taobao.com/item.htm?id=1", shopName: "同行店", title: "Sony MDR-7506", displayPriceMinFen: 65_800, displayPriceMaxFen: 65_800, sponsored: false, capturedAt: "2026-08-25T01:30:00.000Z" }],
    issues: [{ id: "issue-1", code: "LOGIN_REQUIRED", platformItemId: null, skuId: null, message: "淘宝登录已失效", evidenceSha256: null, capturedAt: "2026-08-25T01:31:00.000Z" }],
    filters: {},
    totalSkuCount: 2,
    pagination: {
      positions: { page: 1, pageSize: 50, total: 1, totalPages: 1, hasPrevious: false, hasNext: false },
      issues: { page: 1, pageSize: 50, total: 1, totalPages: 1, hasPrevious: false, hasNext: false },
      skus: { page: 1, pageSize: 50, total: 2, totalPages: 1, hasPrevious: false, hasNext: false }
    },
    skus: [
      {
        id: "own-sku", source: "OWN", platformItemId: "own-1", skuId: "own-standard", shopName: "星空乐器专营店", title: "Sony MDR-7506", skuText: "标准版", url: "https://detail.tmall.com/item.htm?id=own-1", ranks: [1],
        positions: [], attributes: {}, components: null, promotions: [], gifts: [],
        prices: { listPriceFen: 69_800, activityPriceFen: 69_800, couponDiscountFen: 0, fullReductionFen: 0, directDiscountFen: 0, mandatoryFeeFen: 0, publicDiscountFen: 0, payableFen: 69_800 },
        stockState: "IN_STOCK", confidence: "CONFIRMED", match: { category: "EXACT", decision: "BARE", comparable: true, confidenceBps: 10_000, reasons: ["型号一致"] },
        combination: { state: "OWN", signature: "sony-7506-standard", label: "标准版", reasons: [] }, selectedOwnSnapshot, alternativeOwnSnapshots: [], differenceFen: null,
        comparison: { state: "OWN", ownPayableFen: 69_800, differenceFen: null }, evidenceSha256: "a".repeat(64), capturedAt: "2026-08-25T01:30:00.000Z"
      },
      {
        id: "competitor-sku", source: "COMPETITOR", platformItemId: "item-1", skuId: "competitor-standard", shopName: "同行店", title: "Sony MDR-7506", skuText: "标准版", url: "https://item.taobao.com/item.htm?id=1", ranks: [1],
        positions: [], attributes: {}, components: null, promotions: [], gifts: [],
        prices: { listPriceFen: 69_799, activityPriceFen: 69_799, couponDiscountFen: 0, fullReductionFen: 0, directDiscountFen: 0, mandatoryFeeFen: 0, publicDiscountFen: 0, payableFen: 69_799 },
        stockState: "IN_STOCK", confidence: "CONFIRMED", match: { category: "EXACT", decision: "BARE", comparable: true, confidenceBps: 10_000, reasons: ["型号一致"] },
        combination: { state: "MATCHED", signature: "sony-7506-standard", label: "标准版", reasons: [] }, selectedOwnSnapshot, alternativeOwnSnapshots: [], differenceFen: 1,
        comparison: { state: "LOWER", ownPayableFen: 69_800, differenceFen: 1 }, evidenceSha256: "b".repeat(64), capturedAt: "2026-08-25T01:30:00.000Z"
      }
    ]
  };
}

function renderPage() {
  return render(<MemoryRouter initialEntries={["/runs/run-1"]}><Routes><Route path="/runs/:runId" element={<CollectionRunDetailPage />} /></Routes></MemoryRouter>);
}

describe("CollectionRunDetailPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchCollectionEvidence).mockReset();
    vi.mocked(requeueCollectionRun).mockReset();
    vi.mocked(requeueCollectionRun).mockResolvedValue({ runId: "run-1" });
  });

  it("opens the evidence window synchronously before awaiting protected evidence bytes", async () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("SUCCEEDED"), loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    const events: string[] = [];
    let resolveEvidence!: (blob: Blob) => void;
    vi.mocked(fetchCollectionEvidence).mockImplementation(() => {
      events.push("fetch");
      return new Promise<Blob>((resolve) => { resolveEvidence = resolve; });
    });
    const popup = { close: vi.fn(), location: { href: "about:blank" }, opener: window };
    vi.spyOn(window, "open").mockImplementation(() => {
      events.push("open");
      return popup as unknown as Window;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture-evidence");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "查看证据" })[0]!);
    expect(events).toEqual(["open", "fetch"]);

    resolveEvidence(new Blob(["fixture"], { type: "image/png" }));
    await vi.waitFor(() => expect(popup.location.href).toBe("blob:fixture-evidence"));
    expect(popup.opener).toBeNull();
  });

  it("shows all SKU price components and gives a paused login run an operator-only recovery action", async () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("PAUSED_LOGIN"), loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.getByText("47 / 50，未完成")).toBeInTheDocument();
    expect(screen.getAllByText(/公开优惠/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "搜索位置" })).toBeInTheDocument();
    expect(within(screen.getByTestId("collection-run-positions-scroll")).getByText("排名 1")).toBeInTheDocument();
    expect(screen.getByTestId("collection-run-positions-scroll")).toHaveClass("collection-runs-scroll");
    expect(screen.getByTestId("collection-run-skus-scroll")).toHaveClass("collection-runs-scroll");
    expect(screen.getByText("请在已登记的 Mac 上打开淘宝桌面版，恢复登录后再重新入队。"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重新入队/ }));
    expect(requeueCollectionRun).toHaveBeenCalledWith("run-1");
  });

  it("renders authoritative business sections and expands a shop into full item and SKU facts", () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("SUCCEEDED"), loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.getByText("前 50 价盘")).toBeInTheDocument();
    expect(screen.getByText("确认低价同行")).toBeInTheDocument();
    expect(screen.getByText("我方缺失组合")).toBeInTheDocument();
    expect(screen.getByText("索尼聚鑫数码商城")).toBeInTheDocument();
    expect(screen.getByText("低 ¥21.00")).toBeInTheDocument();
    expect(screen.getAllByText("无同组合我方基准，不属于低价告警")).toHaveLength(2);
    expect(screen.getAllByText("排名 1、4").length).toBeGreaterThan(0);
    expect(screen.getByText("我方有组合但当前无库存")).toBeInTheDocument();
    expect(screen.getByText("我方目录采集不完整")).toBeInTheDocument();
    expect(screen.getByText("部分覆盖：已捕获 47 / 50 个搜索位置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开店铺 索尼聚鑫数码商城" }));
    expect(screen.getAllByRole("link", { name: "https://item.taobao.com/item.htm?id=competitor-business" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "https://item.taobao.com/item.htm?id=empty-item" }))
      .toHaveAttribute("href", "https://item.taobao.com/item.htm?id=empty-item");
    expect(screen.getAllByText("黑色 / 标准版").length).toBeGreaterThan(0);
    expect(screen.getAllByText("店铺券 ¥10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("有库存").length).toBeGreaterThan(0);
    expect(screen.getAllByText("我方 ¥690.00").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "https://detail.tmall.com/item.htm?id=own-alternative" }).length).toBeGreaterThan(0);
  });

  it("keeps all three business tables horizontally scrollable at narrow widths", () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("SUCCEEDED"), loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    const { container } = renderPage();

    const wrappers = container.querySelectorAll(".run-business-table-scroll");
    expect(wrappers).toHaveLength(3);
    wrappers.forEach((wrapper) => expect(wrapper).toHaveClass("collection-runs-scroll"));
    expect(container.querySelector(".run-business-table-scroll .ant-table-content"))
      .toHaveStyle({ overflowX: "auto" });
  });

  it("does not surface requeue controls for a running report", () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("RUNNING"), loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.queryByRole("button", { name: /重新入队/ })).not.toBeInTheDocument();
  });

  it("does not render a synthetic report while the first detail request is loading", () => {
    vi.mocked(useApiData).mockReturnValue({ data: null, loading: true, error: null, errorStatus: null, hasSuccessfulData: false, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.getByText("正在加载采集运行")).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 50/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "搜索位置" })).not.toBeInTheDocument();
  });

  it.each([
    [404, "采集运行不存在"],
    [403, "需要管理员权限"],
    [0, "采集运行加载失败"]
  ])("renders a dedicated initial error state for status %s", (errorStatus, title) => {
    vi.mocked(useApiData).mockReturnValue({
      data: null,
      loading: false,
      error: errorStatus === 404 ? "Not Found" : errorStatus === 403 ? "Forbidden resource" : "无法连接后台接口",
      errorStatus,
      hasSuccessfulData: false,
      refresh: vi.fn(),
      setData: vi.fn()
    });
    renderPage();

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 50/)).not.toBeInTheDocument();
  });

  it("renders explicit table empty states only after a successful empty detail response", () => {
    const empty = report("SUCCEEDED");
    empty.completion = { ...empty.completion, positionsCaptured: 0, uniqueItemCount: 0, skuCount: 0, incompleteCount: 0, label: "0 / 50，未完成" };
    empty.positions = [];
    empty.issues = [];
    empty.skus = [];
    empty.businessSummary = { distinctShopCount: 0, distinctItemCount: 0, skuCount: 0, matchedSkuCount: 0, confirmedLowCount: 0, missingCombinationCount: 0, reviewCount: 0, excludedCount: 0, ownConfiguredListingCount: 0, ownCollectedListingCount: 0, ownCatalogComplete: true };
    empty.priceBoard = { shops: [] };
    empty.confirmedLows = [];
    empty.missingOwnGroups = [];
    empty.totalSkuCount = 0;
    empty.pagination = {
      positions: { page: 1, pageSize: 50, total: 0, totalPages: 0, hasPrevious: false, hasNext: false },
      issues: { page: 1, pageSize: 50, total: 0, totalPages: 0, hasPrevious: false, hasNext: false },
      skus: { page: 1, pageSize: 50, total: 0, totalPages: 0, hasPrevious: false, hasNext: false }
    };
    vi.mocked(useApiData).mockReturnValue({ data: empty, loading: false, error: null, errorStatus: null, hasSuccessfulData: true, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.getByText("0 / 50，未完成")).toBeInTheDocument();
    expect(screen.getByText("暂无搜索位置")).toBeInTheDocument();
    expect(screen.getByText("暂无 SKU")).toBeInTheDocument();
    expect(screen.getByText("暂无问题")).toBeInTheDocument();
    expect(screen.getByText("暂无价盘数据")).toBeInTheDocument();
    expect(screen.getByText("暂无确认低价同行")).toBeInTheDocument();
    expect(screen.getByText("暂无我方缺失组合")).toBeInTheDocument();
  });
});
