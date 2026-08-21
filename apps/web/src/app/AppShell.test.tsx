import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell.tsx";

vi.mock("../api/client.ts", () => ({
  useApiData: () => ({
    data: { status: "ok", database: "up", redis: "up" },
    error: null,
    loading: false
  })
}));

describe("AppShell", () => {
  it("labels the public build as a non-automated prototype", () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<div>页面内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("开发原型")).toBeInTheDocument();
    expect(screen.getByText(/不会自动执行定时采集，也不会自动发送企业微信消息/)).toBeInTheDocument();
    expect(screen.getByText("服务正常")).toBeInTheDocument();
  });
});
