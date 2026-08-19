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
});
