import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiData } from "../api/client.ts";
import { CollectionRunsPage } from "./CollectionRunsPage.tsx";

vi.mock("../api/client.ts", () => ({ useApiData: vi.fn() }));

const run = {
  id: "run-1",
  status: "PARTIAL_FAILED",
  provider: "taobao-desktop",
  scheduledFor: "2026-08-25T01:30:00.000Z",
  startedAt: "2026-08-25T01:30:10.000Z",
  finishedAt: "2026-08-25T01:38:00.000Z",
  model: { id: "model-1", monitorCode: "SONY-7506", label: "Sony MDR-7506", comparisonType: "BARE", owner: "运营A" },
  collector: { id: "agent-1", name: "mac-studio-1", platform: "MACOS", appVersion: "2.4.5" },
  completion: { positionsCaptured: 47, requestedPositions: 50, discoveredCount: 47, fetchedCount: 47, matchedCount: 44, failedCount: 3, uniqueItemCount: 47, skuCount: 94, incompleteCount: 3, complete: false, label: "47 / 50，未完成" },
  notification: { state: "PENDING", attempts: 1, notifiedAt: null, lastError: "WECOM_NOT_CONFIGURED" },
  error: { code: "SKU_ENUMERATION_INCOMPLETE", message: "3 个 SKU 未完成采集" }
};

describe("CollectionRunsPage", () => {
  beforeEach(() => {
    vi.mocked(useApiData).mockReturnValue({
      data: {
        runs: [run],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, hasPrevious: false, hasNext: false }
      },
      loading: false,
      error: null,
      errorStatus: null,
      hasSuccessfulData: true,
      refresh: vi.fn(),
      setData: vi.fn()
    });
  });

  it("makes incomplete first-fifty collection visible instead of presenting it as complete", () => {
    render(<MemoryRouter><CollectionRunsPage /></MemoryRouter>);

    expect(screen.getByText("47 / 50，未完成")).toBeInTheDocument();
    expect(screen.getByText("3 个未完成")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();
  });

  it("uses a dedicated horizontally scrollable table container for narrow screens", () => {
    render(<MemoryRouter><CollectionRunsPage /></MemoryRouter>);

    expect(screen.getByTestId("collection-runs-scroll")).toHaveClass("collection-runs-scroll");
  });

  it("renders an explicit initial loading state without fabricated report rows", () => {
    vi.mocked(useApiData).mockReturnValue({
      data: null,
      loading: true,
      error: null,
      errorStatus: null,
      hasSuccessfulData: false,
      refresh: vi.fn(),
      setData: vi.fn()
    });

    render(<MemoryRouter><CollectionRunsPage /></MemoryRouter>);

    expect(screen.getByText("正在加载采集报告")).toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 50/)).not.toBeInTheDocument();
  });

  it("distinguishes initial ADMIN failure from a successful empty list", () => {
    vi.mocked(useApiData).mockReturnValue({
      data: null,
      loading: false,
      error: "Forbidden resource",
      errorStatus: 403,
      hasSuccessfulData: false,
      refresh: vi.fn(),
      setData: vi.fn()
    });
    const first = render(<MemoryRouter><CollectionRunsPage /></MemoryRouter>);
    expect(screen.getByText("需要管理员权限")).toBeInTheDocument();
    expect(screen.queryByText("暂无采集运行")).not.toBeInTheDocument();
    first.unmount();

    vi.mocked(useApiData).mockReturnValue({
      data: {
        runs: [],
        pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0, hasPrevious: false, hasNext: false }
      },
      loading: false,
      error: null,
      errorStatus: null,
      hasSuccessfulData: true,
      refresh: vi.fn(),
      setData: vi.fn()
    });
    render(<MemoryRouter><CollectionRunsPage /></MemoryRouter>);
    expect(screen.getByText("暂无采集运行")).toBeInTheDocument();
  });
});
