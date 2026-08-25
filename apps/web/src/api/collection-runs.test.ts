import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "./client.ts";
import { createCollectionRun, requeueCollectionRun } from "./collection-runs.ts";

vi.mock("./client.ts", () => ({ apiRequest: vi.fn() }));

beforeEach(() => vi.mocked(apiRequest).mockReset());

describe("collection run API", () => {
  it("uses the shared ADMIN client for manual runs", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ runId: "run-1", coalesced: false });

    await createCollectionRun({ monitoredModelId: "model-1", searchLimit: 50 });

    expect(apiRequest).toHaveBeenCalledWith("/api/collection-runs", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ monitoredModelId: "model-1", searchLimit: 50 })
    });
  });

  it("uses the shared ADMIN client for paused-run retry", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ runId: "run-1" });

    await requeueCollectionRun("run-1");

    expect(apiRequest).toHaveBeenCalledWith("/api/collection-runs/run-1/requeue", {
      method: "POST",
      role: "ADMIN"
    });
  });
});
