import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lockAdminSession, unlockAdminSession } from "../auth/admin-session.ts";
import { ApiError, apiRequest, useApiData } from "./client.ts";

afterEach(() => {
  lockAdminSession();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("returns parsed JSON for a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));

    await expect(apiRequest<{ status: string }>("/api/health")).resolves.toEqual({ status: "ok" });
  });

  it("throws a readable ApiError for a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "没有权限" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    })));

    const error = await apiRequest("/api/settings/schedule").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: "没有权限" });
  });

  it("does not turn a forged ADMIN role or identity header into authorization", async () => {
    let sentHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ message: "没有权限" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      });
    }));

    await expect(apiRequest("/api/settings/schedule", {
      method: "PATCH",
      role: "ADMIN",
      headers: { "x-role": "ADMIN", "x-actor-id": "forged-admin" }
    })).rejects.toMatchObject({ status: 403 });

    expect(sentHeaders.get("authorization")).toBeNull();
    expect(sentHeaders.get("x-role")).toBeNull();
    expect(sentHeaders.get("x-actor-id")).toBeNull();
  });

  it("does not send a Bearer credential while the admin session is locked", async () => {
    let sentHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    await apiRequest("/api/catalog/models", { method: "POST", role: "ADMIN" });

    expect(sentHeaders.get("authorization")).toBeNull();
  });

  it("sends the unlocked session credential on ADMIN requests", async () => {
    const token = "test-admin-token-with-more-than-thirty-two-characters";
    unlockAdminSession(token);
    let sentHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    await apiRequest("/api/settings/provider", { method: "PATCH", role: "ADMIN" });

    expect(sentHeaders.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("does not expose an unlocked credential to OPERATOR requests", async () => {
    unlockAdminSession("test-admin-token-with-more-than-thirty-two-characters");
    let sentHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    await apiRequest("/api/health");

    expect(sentHeaders.get("authorization")).toBeNull();
  });

  it("stops sending the credential after the admin session is cleared", async () => {
    unlockAdminSession("test-admin-token-with-more-than-thirty-two-characters");
    lockAdminSession();
    let sentHeaders = new Headers();
    vi.stubGlobal("fetch", vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    await apiRequest("/api/catalog/import", { method: "POST", role: "ADMIN" });

    expect(sentHeaders.get("authorization")).toBeNull();
  });

  it.each([401, 403])("clears an unlocked credential after an ADMIN %s response", async (status) => {
    unlockAdminSession("test-admin-token-with-more-than-thirty-two-characters");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "凭证已失效" }), {
      status,
      headers: { "content-type": "application/json" }
    })));

    await expect(apiRequest("/api/settings/schedule", { role: "ADMIN" })).rejects.toMatchObject({ status });

    expect(sessionStorage.length).toBe(0);
  });

  it("retries one protected query after unlock and sends the Bearer credential", async () => {
    const token = "fresh-tab-admin-token-with-more-than-thirty-two-characters";
    const sentHeaders: Headers[] = [];
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders.push(new Headers(init?.headers));
      if (sentHeaders.length === 1) {
        return new Response(JSON.stringify({ message: "Forbidden resource" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ runs: ["run-1"] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const hook = renderHook(() => useApiData<{ runs: string[] }>(
      "/api/operations/collection-runs",
      null,
      { role: "ADMIN" }
    ));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(hook.result.current.hasSuccessfulData).toBe(false);
    act(() => unlockAdminSession(token));
    await waitFor(() => expect(hook.result.current.data).toEqual({ runs: ["run-1"] }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentHeaders[0]?.get("authorization")).toBeNull();
    expect(sentHeaders[1]?.get("authorization")).toBe(`Bearer ${token}`);
    expect(hook.result.current.hasSuccessfulData).toBe(true);
  });

  it("does not loop after an unlocked ADMIN query is rejected", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "Forbidden resource" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useApiData("/api/operations/collection-runs", null, { role: "ADMIN" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => unlockAdminSession("invalid-admin-token-with-more-than-thirty-two-characters"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
