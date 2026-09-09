import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type {
  CollectorClaimInput,
  CollectorSessionState
} from "../../../../packages/contracts/src/index.ts";

import { createPrismaClient } from "../database/prisma.service.ts";
import {
  COLLECTOR_RUN_LEASE_MILLISECONDS,
  PrismaCollectorAgentRepository
} from "./prisma-collector-agent.repository.ts";

const prisma = createPrismaClient();
const prefix = `COLLECTOR-RECOVERY-${process.pid}-${Date.now()}`;
const ids: { model?: string; owner?: string; other?: string; run?: string } = {};

function claimInput(state: CollectorSessionState = "READY"): CollectorClaimInput {
  return {
    appVersion: "2.4.5",
    capabilities: ["accessibility", "all-sku", "png-evidence"],
    session: { state, observedAt: new Date().toISOString() }
  };
}

before(async () => {
  await prisma.$connect();
  const model = await prisma.monitoredModel.create({
    data: {
      monitorCode: `${prefix}-MODEL`,
      brand: "Fixture",
      standardModel: "MODEL-1",
      category: "fixture",
      searchQuery: "fixture model",
      comparisonType: "BARE",
      owner: "fixture-owner",
      ownListings: {
        create: {
          platformItemId: "fixture-own",
          url: "https://example.test/item.htm?id=fixture-own",
          skuText: "MODEL-1 单机"
        }
      }
    }
  });
  ids.model = model.id;
  const [owner, other] = await Promise.all([
    prisma.collectorAgent.create({
      data: { name: `${prefix}-OWNER`, platform: "MACOS", tokenHash: `${prefix}-TOKEN-OWNER` }
    }),
    prisma.collectorAgent.create({
      data: { name: `${prefix}-OTHER`, platform: "MACOS", tokenHash: `${prefix}-TOKEN-OTHER` }
    })
  ]);
  ids.owner = owner.id;
  ids.other = other.id;
});

beforeEach(async () => {
  await prisma.collectorSessionIncident.deleteMany({
    where: { collectorAgentId: { in: [ids.owner!, ids.other!] } }
  });
  if (ids.model) {
    await prisma.collectionRun.deleteMany({ where: { monitoredModelId: ids.model } });
  }
  await prisma.collectorAgent.updateMany({
    where: { id: { in: [ids.owner!, ids.other!] } },
    data: {
      sessionState: "UNAVAILABLE",
      sessionObservedAt: null,
      sessionChangedAt: null
    }
  });
});

after(async () => {
  if (ids.run) await prisma.collectionRun.deleteMany({ where: { id: ids.run } });
  if (ids.model) await prisma.monitoredModel.deleteMany({ where: { id: ids.model } });
  await prisma.collectorAgent.deleteMany({ where: { id: { in: [ids.owner!, ids.other!] } } });
  await prisma.$disconnect();
});

test("only the owning agent reclaims a stale running checkpoint lease", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date()
    }
  });
  ids.run = run.id;
  const repository = new PrismaCollectorAgentRepository(prisma);
  const capabilities = claimInput();

  const originallyClaimed = await repository.claimNext(ids.owner!, capabilities);
  assert.equal(originallyClaimed?.runId, run.id);
  assert.equal(originallyClaimed?.searchQuery, "fixture model");

  await prisma.monitoredModel.update({
    where: { id: ids.model! },
    data: { searchQuery: "edited catalog query must not replace a checkpoint job" }
  });
  const staleAt = new Date(Date.now() - COLLECTOR_RUN_LEASE_MILLISECONDS - 1_000);
  await prisma.collectionRun.update({
    where: { id: run.id },
    data: { heartbeatAt: staleAt }
  });

  assert.equal(await repository.claimNext(ids.other!, capabilities), null);
  const reclaimed = await repository.claimNext(ids.owner!, capabilities);
  assert.deepEqual(reclaimed, originallyClaimed);

  assert.equal(await repository.claimNext(ids.owner!, capabilities), null);
  assert.equal(await repository.claimNext(ids.other!, capabilities), null);
});

test("a blocked observation persists the agent state without starting queued work", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date()
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);
  const input = claimInput("LOGIN_REQUIRED");

  assert.equal(await repository.claimNext(ids.owner!, input), null);
  const agent = await prisma.collectorAgent.findUniqueOrThrow({
    where: { id: ids.owner! },
    select: { sessionState: true, sessionObservedAt: true, sessionChangedAt: true }
  });
  assert.equal(agent.sessionState, "LOGIN_REQUIRED");
  assert.deepEqual(agent.sessionObservedAt, new Date(input.session.observedAt));
  assert.ok(agent.sessionChangedAt instanceof Date);
  assert.equal(await prisma.collectionRun.count({ where: { id: run.id, status: "RUNNING" } }), 0);
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "QUEUED");
});

test("blocked, ready, then blocked creates two ordered incidents atomically", async () => {
  const repository = new PrismaCollectorAgentRepository(prisma);
  const firstBlockedAt = new Date("2026-09-09T01:30:00.000Z");
  const readyAt = new Date("2026-09-09T01:31:00.000Z");
  const secondBlockedAt = new Date("2026-09-09T01:32:00.000Z");

  await repository.claimNext(ids.owner!, {
    ...claimInput("LOGIN_REQUIRED"),
    session: { state: "LOGIN_REQUIRED", observedAt: firstBlockedAt.toISOString() }
  });
  const first = await prisma.collectorSessionIncident.findUnique({ where: { activeKey: ids.owner! } });
  assert.ok(first);
  await prisma.collectorSessionIncident.update({
    where: { id: first.id },
    data: {
      notificationState: "SENDING",
      notificationAttempts: 1,
      notificationStartedAt: firstBlockedAt
    }
  });

  await repository.claimNext(ids.owner!, {
    ...claimInput("READY"),
    session: { state: "READY", observedAt: readyAt.toISOString() }
  });
  await repository.claimNext(ids.owner!, {
    ...claimInput("LOGIN_REQUIRED"),
    session: { state: "LOGIN_REQUIRED", observedAt: secondBlockedAt.toISOString() }
  });

  const incidents = await prisma.collectorSessionIncident.findMany({
    where: { collectorAgentId: ids.owner! },
    orderBy: { openedAt: "asc" }
  });
  assert.equal(incidents.length, 2);
  assert.deepEqual(incidents[0]?.recoveredAt, readyAt);
  assert.equal(incidents[0]?.notificationState, "AMBIGUOUS");
  assert.equal(incidents[0]?.activeKey, null);
  assert.deepEqual(incidents[1]?.openedAt, secondBlockedAt);
  assert.equal(incidents[1]?.notificationState, "PENDING");
  assert.equal(incidents[1]?.activeKey, ids.owner);
});

test("an older ready observation cannot overwrite a newer blocked session", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date()
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);
  const newerBlockedAt = new Date("2026-09-09T02:00:00.000Z");
  const olderReadyAt = new Date("2026-09-09T01:59:00.000Z");

  assert.equal(await repository.claimNext(ids.owner!, {
    ...claimInput("LOGIN_REQUIRED"),
    session: { state: "LOGIN_REQUIRED", observedAt: newerBlockedAt.toISOString() }
  }), null);
  assert.equal(await repository.claimNext(ids.owner!, {
    ...claimInput("READY"),
    session: { state: "READY", observedAt: olderReadyAt.toISOString() }
  }), null);

  assert.deepEqual(await prisma.collectorAgent.findUniqueOrThrow({
    where: { id: ids.owner! },
    select: { sessionState: true, sessionObservedAt: true }
  }), { sessionState: "LOGIN_REQUIRED", sessionObservedAt: newerBlockedAt });
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "QUEUED");
});

test("two concurrent ready claims from one agent start exactly one workflow", async () => {
  await prisma.collectionRun.createMany({
    data: [0, 1].map((offset) => ({
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED" as const,
      scheduledFor: new Date(Date.now() + offset)
    }))
  });
  const repository = new PrismaCollectorAgentRepository(prisma);

  const claims = await Promise.all([
    repository.claimNext(ids.owner!, claimInput()),
    repository.claimNext(ids.owner!, claimInput())
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await prisma.collectionRun.count({
    where: { monitoredModelId: ids.model!, status: "RUNNING" }
  }), 1);
});

test("a non-stale owned running workflow blocks the next queued run", async () => {
  const [first, second] = await Promise.all([0, 1].map((offset) => prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date(Date.now() + offset)
    }
  })));
  const repository = new PrismaCollectorAgentRepository(prisma);

  assert.equal((await repository.claimNext(ids.owner!, claimInput()))?.runId, first!.id);
  assert.equal(await repository.claimNext(ids.owner!, claimInput()), null);
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: second!.id } })).status, "QUEUED");
});

test("a ready observation resumes the oldest paused workflow before queued work", async () => {
  const base = Date.now();
  const oldestPaused = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "QUEUED",
      scheduledFor: new Date(base)
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);
  const originalJob = await repository.claimNext(ids.owner!, claimInput());
  assert.equal(originalJob?.runId, oldestPaused.id);
  assert.equal(await repository.pause(
    ids.owner!, oldestPaused.id, "PAUSED_LOGIN", "LOGIN_REQUIRED", "login required"
  ), true);

  const [newerPaused, queued] = await Promise.all([
    prisma.collectionRun.create({
      data: {
        monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "PAUSED_LOGIN",
        collectorAgentId: ids.owner!, scheduledFor: new Date(base + 1),
        errorCode: "LOGIN_REQUIRED", errorMessage: "login required"
      }
    }),
    prisma.collectionRun.create({
      data: {
        monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "QUEUED",
        scheduledFor: new Date(base - 1)
      }
    })
  ]);

  assert.deepEqual(await repository.claimNext(ids.owner!, claimInput()), originalJob);
  assert.deepEqual(await prisma.collectionRun.findUniqueOrThrow({
    where: { id: oldestPaused.id },
    select: { status: true, errorCode: true, errorMessage: true, claimedJob: true }
  }), { status: "RUNNING", errorCode: null, errorMessage: null, claimedJob: originalJob });
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: newerPaused.id } })).status, "PAUSED_LOGIN");
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: queued.id } })).status, "QUEUED");
});

test("a challenge-paused workflow resumes only after a ready observation", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "PAUSED_CHALLENGE",
      collectorAgentId: ids.owner!, scheduledFor: new Date(),
      errorCode: "PLATFORM_CHALLENGE", errorMessage: "challenge required"
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);

  assert.equal(await repository.claimNext(ids.owner!, claimInput("CHALLENGE_REQUIRED")), null);
  assert.equal((await prisma.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PAUSED_CHALLENGE");
  assert.equal((await repository.claimNext(ids.owner!, claimInput("READY")))?.runId, run.id);
});

test("pausing a running workflow transactionally blocks the owning collector session", async () => {
  const run = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "QUEUED",
      scheduledFor: new Date()
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);
  assert.equal((await repository.claimNext(ids.owner!, claimInput()))?.runId, run.id);

  assert.equal(await repository.pause(
    ids.owner!, run.id, "PAUSED_LOGIN", "LOGIN_REQUIRED", "operator action required"
  ), true);

  assert.deepEqual(await prisma.collectionRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { status: true, errorCode: true }
  }), { status: "PAUSED_LOGIN", errorCode: "LOGIN_REQUIRED" });
  const agent = await prisma.collectorAgent.findUniqueOrThrow({
    where: { id: ids.owner! },
    select: { sessionState: true, sessionObservedAt: true, sessionChangedAt: true }
  });
  assert.equal(agent.sessionState, "LOGIN_REQUIRED");
  assert.ok(agent.sessionObservedAt instanceof Date);
  assert.ok(agent.sessionChangedAt instanceof Date);
});

test("a stale owned running checkpoint is reclaimed before paused or queued work", async () => {
  const base = Date.now();
  const stale = await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "RUNNING",
      collectorAgentId: ids.owner!, scheduledFor: new Date(base + 2),
      heartbeatAt: new Date(base - COLLECTOR_RUN_LEASE_MILLISECONDS - 1_000)
    }
  });
  await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "PAUSED_LOGIN",
      collectorAgentId: ids.owner!, scheduledFor: new Date(base),
      errorCode: "LOGIN_REQUIRED", errorMessage: "login required"
    }
  });
  await prisma.collectionRun.create({
    data: {
      monitoredModelId: ids.model!, providerKey: "taobao-desktop", status: "QUEUED",
      scheduledFor: new Date(base - 1)
    }
  });
  const repository = new PrismaCollectorAgentRepository(prisma);

  assert.equal((await repository.claimNext(ids.owner!, claimInput()))?.runId, stale.id);
});

test("legacy duplicate stale runs cannot become two active workflows", async () => {
  const base = Date.now();
  const staleAt = new Date(base - COLLECTOR_RUN_LEASE_MILLISECONDS - 1_000);
  await prisma.collectionRun.createMany({
    data: [0, 1].map((offset) => ({
      monitoredModelId: ids.model!,
      providerKey: "taobao-desktop",
      status: "RUNNING" as const,
      collectorAgentId: ids.owner!,
      scheduledFor: new Date(base + offset),
      heartbeatAt: staleAt
    }))
  });
  const repository = new PrismaCollectorAgentRepository(prisma);

  assert.ok(await repository.claimNext(ids.owner!, claimInput()));
  assert.equal(await repository.claimNext(ids.owner!, claimInput()), null);

  const runs = await prisma.collectionRun.findMany({
    where: { monitoredModelId: ids.model!, status: "RUNNING" },
    select: { heartbeatAt: true }
  });
  assert.equal(runs.filter((run) => run.heartbeatAt && run.heartbeatAt > staleAt).length, 1);
});
