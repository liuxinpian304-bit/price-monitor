import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiData } from "../api/client.ts";
import { SettingsPage } from "./SettingsPage.tsx";

vi.mock("../api/client.ts", () => ({ apiRequest: vi.fn(), useApiData: vi.fn() }));

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(useApiData).mockReturnValue({
      data: {
        shopName: "星空乐器专营店",
        provider: "desktop",
        schedulerEnabled: true,
        checkTimes: ["09:30", "10:30"],
        timeZone: "Asia/Shanghai",
        wecomWebhookConfigured: false,
        commerceApiKeyConfigured: false
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
      setData: vi.fn()
    });
  });

  it("labels the desktop collector accurately and keeps external API credentials separate", () => {
    render(<SettingsPage />);

    expect(screen.getByText("淘宝桌面版采集器")).toBeInTheDocument();
    expect(screen.getByText("按设置时段由已登记、已登录的 Mac 桌面采集器自动检查。"))
      .toBeInTheDocument();
    expect(screen.getByText("外部数据 API 密钥")).toBeInTheDocument();
  });
});
