import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiRequest } from "./client.ts";

afterEach(() => vi.unstubAllGlobals());

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

  it("sends a Chinese actor ID as an ASCII-only URI-prefixed header", async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-actor-id")).toBe(`uri:${encodeURIComponent("本地运营")}`);
      expect([...headers.get("x-actor-id") ?? ""].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/api/alerts/demo/actions", {
      method: "POST",
      actorId: "本地运营",
      body: JSON.stringify({ status: "WATCHING" })
    })).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
