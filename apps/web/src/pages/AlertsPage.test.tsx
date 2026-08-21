import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AlertActionForm } from "../features/alerts/AlertActionForm.tsx";
import { AlertsPage } from "./AlertsPage.tsx";

describe("AlertsPage", () => {
  it("keeps bare and bundle alerts in separate tabs and highlights lower prices", () => {
    render(<MemoryRouter><AlertsPage /></MemoryRouter>);

    expect(screen.getByRole("tab", { name: /裸机预警/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /套装预警/ })).toBeInTheDocument();
    expect(screen.getByText("RME Babyface Pro FS")).toBeInTheDocument();
    expect(screen.getByText("¥7009.99")).toHaveClass("risk-price");

    fireEvent.click(screen.getByRole("tab", { name: /套装预警/ }));
    expect(screen.getByText(/MK4录音套装/)).toBeInTheDocument();
  });
});

describe("AlertActionForm", () => {
  it("requires a reason before submitting NO_FOLLOW", async () => {
    const onSubmit = vi.fn();
    render(<AlertActionForm onSubmit={onSubmit} />);

    fireEvent.mouseDown(screen.getByLabelText("处理结果"));
    fireEvent.click(await screen.findByText("不跟价"));
    await screen.findByLabelText("处理原因");
    fireEvent.click(screen.getByRole("button", { name: "确认处理" }));

    expect(await screen.findByText("请选择不跟价原因")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
