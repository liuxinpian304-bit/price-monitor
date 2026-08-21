import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImportDialog } from "./ImportDialog.tsx";

describe("ImportDialog", () => {
  it("shows exact sheet, row and field for every import error", () => {
    render(<ImportDialog
      open
      onClose={vi.fn()}
      errors={[
        { sheet: "监控型号", row: 8, field: "比价类型", message: "仅允许填写裸机或套装" },
        { sheet: "型号别名", row: 12, field: "标准型号", message: "未出现在监控型号表" }
      ]}
    />);

    expect(screen.getByText("监控型号")).toBeInTheDocument();
    expect(screen.getByText("第 8 行")).toBeInTheDocument();
    expect(screen.getByText("比价类型")).toBeInTheDocument();
    expect(screen.getByText("第 12 行")).toBeInTheDocument();
  });
});
