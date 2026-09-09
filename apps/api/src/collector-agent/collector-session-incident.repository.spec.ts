import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS,
  MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS,
  PrismaCollectorSessionIncidentRepository
} from "./collector-session-incident.repository.ts";

function blockedIncident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    collectorAgentId: "agent-1",
    state: "LOGIN_REQUIRED",
    activeKey: "agent-1",
    openedAt: new Date("2026-09-09T01:30:00.000Z"),
    recoveredAt: null,
    notificationState: "PENDING",
    notificationAttempts: 0,
    notificationStartedAt: null,
    notifiedAt: null,
    lastNotificationError: null,
    collectorAgent: { name: "固定采集 Mac" },
    ...overrides
  };
}

test("observeBlocked upserts one active incident per collector without reopening it", async () => {
  const inputs: unknown[] = [];
  const openedAt = new Date("2026-09-09T01:30:00.000Z");
  const challengeAt = new Date("2026-09-09T01:31:00.000Z");
  let persisted = { sessionState: "LOGIN_REQUIRED", sessionObservedAt: openedAt };
  let locks = 0;
  const transaction = {
    $queryRaw: async () => {
      locks += 1;
      return [persisted];
    },
    collectorSessionIncident: {
      upsert: async (input: unknown) => {
        inputs.push(input);
        return { id: "incident-1" };
      }
    }
  };
  const prisma = { $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
  const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);

  assert.equal(await repository.observeBlocked("agent-1", "LOGIN_REQUIRED", openedAt), "incident-1");
  persisted = { sessionState: "CHALLENGE_REQUIRED", sessionObservedAt: challengeAt };
  assert.equal(await repository.observeBlocked("agent-1", "CHALLENGE_REQUIRED", challengeAt), "incident-1");

  assert.equal(inputs.length, 2);
  assert.equal(locks, 2);
  const first = inputs[0] as {
    where: { activeKey: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  };
  assert.equal(first.where.activeKey, "agent-1");
  assert.deepEqual(first.create, {
    collectorAgentId: "agent-1",
    state: "LOGIN_REQUIRED",
    activeKey: "agent-1",
    openedAt
  });
  assert.deepEqual(first.update, { state: "LOGIN_REQUIRED" });
});

test("observeReady closes only the collector's unresolved incident", async () => {
  const inputs: unknown[] = [];
  const recoveredAt = new Date("2026-09-09T02:30:00.000Z");
  const transaction = {
    $queryRaw: async () => [{
        sessionState: "READY",
        sessionObservedAt: recoveredAt
      }],
    collectorSessionIncident: {
      updateMany: async (input: unknown) => {
        inputs.push(input);
        return { count: 1 };
      }
    }
  };
  const prisma = { $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
  const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);

  await repository.observeReady("agent-1", recoveredAt);

  assert.deepEqual(inputs, [
    {
      where: {
        activeKey: "agent-1",
        recoveredAt: null,
        notificationState: "SENDING"
      },
      data: {
        notificationState: "AMBIGUOUS",
        lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
      }
    },
    {
      where: {
        activeKey: "agent-1",
        recoveredAt: null,
        openedAt: { lte: recoveredAt }
      },
      data: { activeKey: null, recoveredAt }
    }
  ]);
});

test("stale observations cannot open or close an incident against the persisted session", async () => {
  const newerAt = new Date("2026-09-09T02:00:00.000Z");
  const olderAt = new Date("2026-09-09T01:59:00.000Z");
  let persisted = { sessionState: "LOGIN_REQUIRED", sessionObservedAt: newerAt };
  let upserts = 0;
  let closes = 0;
  const transaction = {
    $queryRaw: async () => [persisted],
    collectorSessionIncident: {
      upsert: async () => {
        upserts += 1;
        return { id: "incident-1" };
      },
      updateMany: async () => {
        closes += 1;
        return { count: 1 };
      }
    }
  };
  const prisma = { $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
  const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);

  await repository.observeReady("agent-1", olderAt);
  persisted = { sessionState: "READY", sessionObservedAt: newerAt };
  assert.equal(await repository.observeBlocked("agent-1", "LOGIN_REQUIRED", olderAt), null);

  assert.equal(upserts, 0);
  assert.equal(closes, 0);
});

test("incident reconciliation requires the exact persisted observation timestamp", async () => {
  const persistedAt = new Date("2026-09-09T02:00:00.000Z");
  const mismatchedAt = new Date("2026-09-09T02:00:01.000Z");
  let persisted = { sessionState: "LOGIN_REQUIRED", sessionObservedAt: persistedAt };
  let upserts = 0;
  let closes = 0;
  const transaction = {
    $queryRaw: async () => [persisted],
    collectorSessionIncident: {
      upsert: async () => {
        upserts += 1;
        return { id: "incident-1" };
      },
      updateMany: async () => {
        closes += 1;
        return { count: 1 };
      }
    }
  };
  const prisma = { $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction) };
  const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);

  assert.equal(
    await repository.observeBlocked("agent-1", "LOGIN_REQUIRED", mismatchedAt),
    null
  );
  persisted = { sessionState: "READY", sessionObservedAt: persistedAt };
  await repository.observeReady("agent-1", mismatchedAt);

  assert.equal(upserts, 0);
  assert.equal(closes, 0);
});

test("claimPending atomically claims only a pending unresolved incident", async () => {
  const updateInputs: unknown[] = [];
  const incident = blockedIncident();
  const prisma = {
    collectorSessionIncident: {
      findUnique: async () => incident,
      updateMany: async (input: unknown) => {
        updateInputs.push(input);
        return { count: 1 };
      }
    }
  };
  const notificationStartedAt = new Date("2026-09-09T01:30:30.000Z");
  const repository = new PrismaCollectorSessionIncidentRepository(
    prisma as never,
    () => notificationStartedAt
  );

  assert.deepEqual(await repository.claimPending("agent-1"), {
    id: "incident-1",
    agentId: "agent-1",
    agentName: "固定采集 Mac",
    state: "LOGIN_REQUIRED",
    openedAt: new Date("2026-09-09T01:30:00.000Z")
  });
  assert.deepEqual(updateInputs, [{
    where: {
      id: "incident-1",
      activeKey: "agent-1",
      recoveredAt: null,
      notificationState: "PENDING",
      notificationAttempts: { lt: MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS }
    },
    data: {
      notificationState: "SENDING",
      notificationAttempts: { increment: 1 },
      notificationStartedAt,
      lastNotificationError: null
    }
  }]);
});

test("claimPending does not reclaim terminal, sending, recovered, or exhausted incidents", async () => {
  for (const overrides of [
    { notificationState: "NOTIFIED" },
    { notificationState: "AMBIGUOUS" },
    { notificationState: "FAILED" },
    { notificationState: "SENDING", notificationStartedAt: new Date() },
    { recoveredAt: new Date() },
    { notificationAttempts: MAX_COLLECTOR_SESSION_NOTIFICATION_ATTEMPTS }
  ]) {
    let updates = 0;
    const prisma = {
      collectorSessionIncident: {
        findUnique: async () => blockedIncident(overrides),
        updateMany: async () => {
          updates += 1;
          return { count: 1 };
        }
      }
    };
    const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);
    assert.equal(await repository.claimPending("agent-1"), null);
    assert.equal(updates, 0);
  }
});

test("claimPending terminalizes an abandoned sending attempt without reposting", async () => {
  const updateInputs: unknown[] = [];
  const prisma = {
    collectorSessionIncident: {
      findUnique: async () => blockedIncident({
        notificationState: "SENDING",
        notificationAttempts: 1,
        notificationStartedAt: new Date("2000-01-01T00:00:00.000Z")
      }),
      updateMany: async (input: unknown) => {
        updateInputs.push(input);
        return { count: 1 };
      }
    }
  };
  const repository = new PrismaCollectorSessionIncidentRepository(
    prisma as never,
    () => new Date(
      new Date("2000-01-01T00:00:00.000Z").getTime()
      + COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS
    )
  );

  assert.equal(await repository.claimPending("agent-1"), null);
  assert.equal(updateInputs.length, 1);
  assert.deepEqual((updateInputs[0] as { data: unknown }).data, {
    notificationState: "AMBIGUOUS",
    lastNotificationError: "WECOM_DELIVERY_AMBIGUOUS"
  });
  assert.deepEqual((updateInputs[0] as { where: { OR: unknown } }).where.OR, [
    { notificationStartedAt: null },
    { notificationStartedAt: { lte: new Date("2000-01-01T00:00:00.000Z") } }
  ]);
});

test("notification outcomes are compare-and-set and explicit failures retry only once", async () => {
  const updateInputs: unknown[] = [];
  let stored = blockedIncident({ notificationState: "SENDING", notificationAttempts: 1 });
  const prisma = {
    collectorSessionIncident: {
      findUnique: async () => stored,
      updateMany: async (input: unknown) => {
        updateInputs.push(input);
        return { count: 1 };
      }
    }
  };
  const repository = new PrismaCollectorSessionIncidentRepository(prisma as never);
  const at = new Date("2026-09-09T01:31:00.000Z");

  await repository.markFailure("incident-1", "WECOM_DELIVERY_FAILED");
  assert.equal((updateInputs.at(-1) as { data: { notificationState: string } }).data.notificationState, "PENDING");
  assert.equal(
    (updateInputs.at(-1) as { data: { notificationStartedAt: null } }).data.notificationStartedAt,
    null
  );

  stored = blockedIncident({ notificationState: "SENDING", notificationAttempts: 2 });
  await repository.markFailure("incident-1", "WECOM_NOT_CONFIGURED");
  assert.equal((updateInputs.at(-1) as { data: { notificationState: string } }).data.notificationState, "FAILED");

  await repository.markFailure("incident-1", "WECOM_DELIVERY_AMBIGUOUS");
  assert.equal((updateInputs.at(-1) as { data: { notificationState: string } }).data.notificationState, "AMBIGUOUS");

  await repository.markNotified("incident-1", at);
  assert.deepEqual((updateInputs.at(-1) as { data: unknown }).data, {
    notificationState: "NOTIFIED",
    notifiedAt: at,
    lastNotificationError: null
  });
});
