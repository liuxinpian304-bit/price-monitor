import assert from "node:assert/strict";
import test from "node:test";

import { PrismaCollectorAgentRepository } from "./prisma-collector-agent.repository.ts";

const REQUIRED_CAPABILITIES = ["accessibility", "all-sku", "png-evidence"];

function claimRepository(platform: "MACOS" | "WINDOWS") {
  const findFirstInputs: unknown[] = [];
  const transaction = {
    collectorAgent: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ platform })
    },
    collectionRun: {
      findFirst: async (input: unknown) => {
        findFirstInputs.push(input);
        return null;
      }
    }
  };
  const prisma = {
    $transaction: async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction)
  };
  return {
    repository: new PrismaCollectorAgentRepository(prisma as never),
    findFirstInputs
  };
}

test("does not claim desktop work for the wrong platform or missing capabilities", async () => {
  for (const [platform, capabilities] of [
    ["WINDOWS", REQUIRED_CAPABILITIES],
    ["MACOS", ["accessibility", "all-sku"]]
  ] as const) {
    const { repository, findFirstInputs } = claimRepository(platform);
    assert.equal(await repository.claimNext("agent-1", {
      appVersion: "2.4.5",
      capabilities: [...capabilities]
    }), null);
    assert.equal(findFirstInputs.length, 0, `${platform}:${capabilities.join(",")}`);
  }
});

test("filters every claim candidate by the compatible provider", async () => {
  const { repository, findFirstInputs } = claimRepository("MACOS");
  assert.equal(await repository.claimNext("agent-1", {
    appVersion: "2.4.5",
    capabilities: REQUIRED_CAPABILITIES
  }), null);

  assert.equal(findFirstInputs.length, 2);
  for (const input of findFirstInputs) {
    const where = (input as { where: Record<string, unknown> }).where;
    assert.deepEqual(where.providerKey, {
      in: ["taobao-desktop"]
    });
  }
});

test("quarantines an invalid checkpoint as a terminal run", async () => {
  const updateInputs: unknown[] = [];
  const prisma = {
    collectionRun: {
      updateMany: async (input: unknown) => {
        updateInputs.push(input);
        return { count: 1 };
      }
    }
  };
  const repository = new PrismaCollectorAgentRepository(prisma as never);

  assert.equal(await repository.release("agent-1", "run-1", {
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  }), true);
  const data = (updateInputs[0] as { data: Record<string, unknown> }).data;
  assert.equal(data.status, "FAILED");
  assert.equal(data.errorCode, "INVALID_CHECKPOINT");
  assert.equal(data.errorMessage, "Collector checkpoint requires operator review");
  assert.ok(data.finishedAt instanceof Date);
});
