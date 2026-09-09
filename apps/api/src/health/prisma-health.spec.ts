import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import { PrismaCollectorAgentHealthProbe } from "./prisma-health.ts";

const collectorAgentFreshnessMilliseconds = 5 * 60_000;
const now = new Date("2026-09-07T08:00:00.000Z");

function probeFor(agent: { enabled: boolean; lastSeenAt: Date | null } | null) {
  let query: Record<string, unknown> | undefined;
  const prisma = {
    collectorAgent: {
      findFirst: async (input: Record<string, unknown>) => {
        query = input;
        const where = input.where as {
          enabled?: boolean;
          lastSeenAt?: { gte?: Date };
        };
        const cutoff = where.lastSeenAt?.gte;
        if (!agent || !agent.enabled || !agent.lastSeenAt || !cutoff) return null;
        return agent.lastSeenAt >= cutoff ? { id: "agent-1" } : null;
      }
    }
  } as unknown as PrismaClient;

  return {
    probe: new PrismaCollectorAgentHealthProbe(prisma, () => now),
    query: () => query
  };
}

test("collector agent health requires a recently seen enabled agent", async () => {
  const cases = [
    {
      name: "fresh",
      agent: { enabled: true, lastSeenAt: new Date(now.getTime() - collectorAgentFreshnessMilliseconds + 1) },
      expected: true
    },
    {
      name: "stale",
      agent: { enabled: true, lastSeenAt: new Date(now.getTime() - collectorAgentFreshnessMilliseconds - 1) },
      expected: false
    },
    { name: "missing", agent: null, expected: false },
    {
      name: "disabled",
      agent: { enabled: false, lastSeenAt: now },
      expected: false
    }
  ];

  for (const entry of cases) {
    const fixture = probeFor(entry.agent);

    assert.equal(await fixture.probe.ping(), entry.expected, entry.name);
    assert.deepEqual(fixture.query(), {
      where: {
        enabled: true,
        lastSeenAt: { gte: new Date(now.getTime() - collectorAgentFreshnessMilliseconds) }
      },
      select: { id: true }
    });
  }
});
