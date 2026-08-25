import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiData } from "../api/client.ts";
import { requeueCollectionRun } from "../api/collection-runs.ts";
import { CollectionRunDetailPage } from "./CollectionRunDetailPage.tsx";

vi.mock("../api/client.ts", () => ({ useApiData: vi.fn() }));
vi.mock("../api/collection-runs.ts", () => ({
  fetchCollectionEvidence: vi.fn(),
  requeueCollectionRun: vi.fn()
}));

function report(status: string) {
  return {
    id: "run-1",
    status,
    provider: "taobao-desktop",
    scheduledFor: "2026-08-25T01:30:00.000Z",
    startedAt: "2026-08-25T01:30:10.000Z",
    finishedAt: null,
    model: { id: "model-1", monitorCode: "SONY-7506", label: "Sony MDR-7506", comparisonType: "BARE", owner: "运营A" },
    collector: { id: "agent-1", name: "mac-studio-1", platform: "MACOS", appVersion: "2.4.5" },
    completion: { positionsCaptured: 47, requestedPositions: 50, discoveredCount: 47, fetchedCount: 47, matchedCount: 2, failedCount: 3, uniqueItemCount: 47, skuCount: 2, incompleteCount: 3, complete: false, label: "47 / 50，未完成" },
    notification: { state: "FAILED", attempts: 2, notifiedAt: null, lastError: "WECOM_DELIVERY_FAILED" },
    error: { code: "LOGIN_REQUIRED", message: "淘宝登录已失效" },
    positions: [{ rank: 1, platformItemId: "item-1", url: "https://item.taobao.com/item.htm?id=1", shopName: "同行店", title: "Sony MDR-7506", displayPriceMinFen: 65_800, displayPriceMaxFen: 65_800, sponsored: false, capturedAt: "2026-08-25T01:30:00.000Z" }],
    issues: [{ id: "issue-1", code: "LOGIN_REQUIRED", platformItemId: null, skuId: null, message: "淘宝登录已失效", evidenceSha256: null, capturedAt: "2026-08-25T01:31:00.000Z" }],
    filters: {},
    totalSkuCount: 2,
    skus: [
      {
        id: "own-sku", source: "OWN", platformItemId: "own-1", skuId: "own-standard", shopName: "星空乐器专营店", title: "Sony MDR-7506", skuText: "标准版", url: "https://detail.tmall.com/item.htm?id=own-1", ranks: [1],
        prices: { listPriceFen: 69_800, activityPriceFen: 69_800, couponDiscountFen: 0, fullReductionFen: 0, directDiscountFen: 0, mandatoryFeeFen: 0, publicDiscountFen: 0, payableFen: 69_800 },
        stockState: "IN_STOCK", confidence: "CONFIRMED", match: { category: "EXACT", decision: "BARE", comparable: true, confidenceBps: 10_000, reasons: ["型号一致"] }, comparison: { state: "OWN", ownPayableFen: 69_800, differenceFen: null }, evidenceSha256: "a".repeat(64), capturedAt: "2026-08-25T01:30:00.000Z"
      },
      {
        id: "competitor-sku", source: "COMPETITOR", platformItemId: "item-1", skuId: "competitor-standard", shopName: "同行店", title: "Sony MDR-7506", skuText: "标准版", url: "https://item.taobao.com/item.htm?id=1", ranks: [1],
        prices: { listPriceFen: 69_799, activityPriceFen: 69_799, couponDiscountFen: 0, fullReductionFen: 0, directDiscountFen: 0, mandatoryFeeFen: 0, publicDiscountFen: 0, payableFen: 69_799 },
        stockState: "IN_STOCK", confidence: "CONFIRMED", match: { category: "EXACT", decision: "BARE", comparable: true, confidenceBps: 10_000, reasons: ["型号一致"] }, comparison: { state: "LOWER", ownPayableFen: 69_800, differenceFen: 1 }, evidenceSha256: "b".repeat(64), capturedAt: "2026-08-25T01:30:00.000Z"
      }
    ]
  };
}

function renderPage() {
  return render(<MemoryRouter initialEntries={["/runs/run-1"]}><Routes><Route path="/runs/:runId" element={<CollectionRunDetailPage />} /></Routes></MemoryRouter>);
}

describe("CollectionRunDetailPage", () => {
  beforeEach(() => {
    vi.mocked(requeueCollectionRun).mockReset();
    vi.mocked(requeueCollectionRun).mockResolvedValue({ runId: "run-1" });
  });

  it("shows all SKU price components and gives a paused login run an operator-only recovery action", async () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("PAUSED_LOGIN"), loading: false, error: null, refresh: vi.fn(), setData: vi.fn() });
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

  it("does not surface requeue controls for a running report", () => {
    vi.mocked(useApiData).mockReturnValue({ data: report("RUNNING"), loading: false, error: null, refresh: vi.fn(), setData: vi.fn() });
    renderPage();

    expect(screen.queryByRole("button", { name: /重新入队/ })).not.toBeInTheDocument();
  });
});
