import assert from "node:assert/strict";
import test from "node:test";

import { PrismaCollectorAgentRepository } from "./prisma-collector-agent.repository.ts";

const REQUIRED_CAPABILITIES = ["accessibility", "all-sku", "png-evidence"];

function claimRepository(platform: "MACOS" | "WINDOWS") {
  const findFirstInputs: unknown[] = [];
  const transaction = {
    collectorAgent: {
      updateMany: async () => ({ count: 1 }),
      findFirst: async () => ({ platform, sessionState: "UNAVAILABLE", sessionObservedAt: null })
    },
    collectionRun: {
      findFirst: async (input: unknown) => {
        findFirstInputs.push(input);
        return null;
      }
    },
    collectorSessionIncident: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({ id: "incident-1" })
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
      capabilities: [...capabilities],
      session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
    }), null);
    assert.equal(findFirstInputs.length, 0, `${platform}:${capabilities.join(",")}`);
  }
});

test("filters every claim candidate by the compatible provider", async () => {
  const { repository, findFirstInputs } = claimRepository("MACOS");
  assert.equal(await repository.claimNext("agent-1", {
    appVersion: "2.4.5",
    capabilities: REQUIRED_CAPABILITIES,
    session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
  }), null);

  assert.equal(findFirstInputs.length, 4);
  const providerCandidates = findFirstInputs.filter((input) =>
    "providerKey" in (input as { where: Record<string, unknown> }).where);
  assert.equal(providerCandidates.length, 3);
  for (const input of providerCandidates) {
    const where = (input as { where: Record<string, unknown> }).where;
    assert.deepEqual(where.providerKey, {
      in: ["taobao-desktop"]
    });
  }
  assert.equal(findFirstInputs.some((input) => {
    const where = (input as { where: Record<string, unknown> }).where;
    return where.status === "RUNNING" && where.collectorAgentId === "agent-1"
      && !("providerKey" in where);
  }), true);
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

test("retries a pause transaction after serializable conflicts", async () => {
  let attempts = 0;
  const transaction = {
    collectionRun: {
      updateMany: async () => ({ count: 1 })
    },
    collectorAgent: {
      findUnique: async () => ({ sessionState: "READY" }),
      update: async () => ({ id: "agent-1" })
    },
    collectorSessionIncident: {
      updateMany: async () => ({ count: 0 }),
      upsert: async () => ({ id: "incident-1" })
    }
  };
  const prisma = {
    $transaction: async (operation: (tx: typeof transaction) => Promise<unknown>) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("serialization conflict"), { code: "P2034" });
      return operation(transaction);
    }
  };
  const repository = new PrismaCollectorAgentRepository(prisma as never);

  assert.equal(await repository.pause(
    "agent-1",
    "run-1",
    "PAUSED_LOGIN",
    "LOGIN_REQUIRED",
    "login required"
  ), true);
  assert.equal(attempts, 3);
});
