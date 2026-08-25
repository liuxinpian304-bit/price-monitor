import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiData } from "../api/client.ts";
import { AppShell } from "./AppShell.tsx";

vi.mock("../api/client.ts", () => ({
  useApiData: vi.fn()
}));

describe("AppShell", () => {
  beforeEach(() => {
    vi.mocked(useApiData).mockReturnValue({
      data: { status: "ok", database: "up", redis: "up", runtime: "PROTOTYPE" },
      error: null,
      errorStatus: null,
      loading: false,
      hasSuccessfulData: true,
      refresh: vi.fn(),
      setData: vi.fn()
    });
  });

  function renderShell() {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<div>页面内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  }

  it("keeps the prototype warning until the API reports an assembled runtime", () => {
    renderShell();

    expect(screen.getByText("开发原型")).toBeInTheDocument();
    expect(screen.getByText(/不会依据此页面声称真实淘宝采集或企业微信通知已验收/)).toBeInTheDocument();
    expect(screen.getByText("服务正常")).toBeInTheDocument();
  });

  it("replaces the prototype warning only after assembled runtime health is reported", () => {
    vi.mocked(useApiData).mockReturnValue({
      data: { status: "ok", database: "up", redis: "up", runtime: "ASSEMBLED" },
      error: null,
      errorStatus: null,
      loading: false,
      hasSuccessfulData: true,
      refresh: vi.fn(),
      setData: vi.fn()
    });
    renderShell();

    expect(screen.getByText("桌面采集运行时已装配")).toBeInTheDocument();
    expect(screen.queryByText("开发原型")).not.toBeInTheDocument();
  });
});
