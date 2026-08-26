import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  getAdminSessionToken,
  lockAdminSession,
  requireAdminUnlock,
  unlockAdminSession
} from "./admin-session.ts";
import { AdminAccessControl } from "./AdminAccessControl.tsx";

afterEach(() => {
  lockAdminSession();
  sessionStorage.clear();
});

describe("AdminAccessControl", () => {
  it("unlocks only for the current browser session and can be locked again", async () => {
    render(<AdminAccessControl />);

    fireEvent.click(screen.getByRole("button", { name: "管理员解锁" }));
    fireEvent.change(screen.getByLabelText("管理员凭证"), {
      target: { value: "test-admin-token-with-more-than-thirty-two-characters" }
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /解\s*锁/ }));

    await waitFor(() => expect(screen.getByText("管理员已解锁")).toBeInTheDocument());
    expect(getAdminSessionToken()).toBe("test-admin-token-with-more-than-thirty-two-characters");
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "锁定管理员操作" }));

    expect(screen.getByRole("button", { name: "管理员解锁" })).toBeInTheDocument();
    expect(getAdminSessionToken()).toBeNull();
  });

  it("reopens the unlock flow after an ADMIN authorization failure", async () => {
    unlockAdminSession("test-admin-token-with-more-than-thirty-two-characters");
    render(<AdminAccessControl />);

    act(() => requireAdminUnlock());

    expect(await screen.findByText("管理员凭证无效或已过期，请重新输入。")).toBeInTheDocument();
    expect(screen.getByLabelText("管理员凭证")).toHaveValue("");
    expect(getAdminSessionToken()).toBeNull();
  });
});
