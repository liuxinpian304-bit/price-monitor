import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import {
  COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS,
  PrismaCollectorSessionIncidentRepository
} from "./collector-session-incident.repository.ts";

const prisma = createPrismaClient();
const prefix = `COLLECTOR-SESSION-INCIDENT-${process.pid}-${Date.now()}`;
let agentId = "";

before(async () => {
  await prisma.$connect();
  const agent = await prisma.collectorAgent.create({
    data: {
      name: `${prefix}-MAC`,
      platform: "MACOS",
      tokenHash: `${prefix}-TOKEN`
    }
  });
  agentId = agent.id;
});

beforeEach(async () => {
  await prisma.collectorSessionIncident.deleteMany({ where: { collectorAgentId: agentId } });
  await prisma.collectorAgent.update({
    where: { id: agentId },
    data: {
      sessionState: "UNAVAILABLE",
      sessionObservedAt: null,
      sessionChangedAt: null
    }
  });
});

after(async () => {
  await prisma.collectorAgent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

test("one blocked episode is delivered at most once and closes on recovery", async () => {
  const repository = new PrismaCollectorSessionIncidentRepository(prisma);
  const openedAt = new Date("2026-09-09T01:30:00.000Z");
  await prisma.collectorAgent.update({
    where: { id: agentId },
    data: { sessionState: "LOGIN_REQUIRED", sessionObservedAt: openedAt }
  });

  const firstId = await repository.observeBlocked(agentId, "LOGIN_REQUIRED", openedAt);
  assert.equal(await repository.observeBlocked(agentId, "LOGIN_REQUIRED", openedAt), firstId);
  assert.equal(await prisma.collectorSessionIncident.count({ where: { collectorAgentId: agentId } }), 1);

  const claims = await Promise.all([
    repository.claimPending(agentId),
    repository.claimPending(agentId)
  ]);
  const firstDelivery = claims.find(Boolean);
  assert.ok(firstDelivery);
  assert.equal(claims.filter(Boolean).length, 1);
  await repository.markFailure(firstDelivery.id, "WECOM_DELIVERY_FAILED");

  const retry = await repository.claimPending(agentId);
  assert.equal(retry?.id, firstId);
  await repository.markNotified(retry!.id, new Date("2026-09-09T01:31:00.000Z"));
  assert.equal(await repository.claimPending(agentId), null);

  const recoveredAt = new Date("2026-09-09T01:32:00.000Z");
  await prisma.collectorAgent.update({
    where: { id: agentId },
    data: { sessionState: "READY", sessionObservedAt: recoveredAt }
  });
  await repository.observeReady(agentId, recoveredAt);

  const stored = await prisma.collectorSessionIncident.findUniqueOrThrow({ where: { id: firstId! } });
  assert.equal(stored.activeKey, null);
  assert.deepEqual(stored.recoveredAt, recoveredAt);
  assert.equal(stored.notificationState, "NOTIFIED");
  assert.equal(stored.notificationAttempts, 2);
});

test("a stale blocked observation cannot create a new incident after recovery", async () => {
  const repository = new PrismaCollectorSessionIncidentRepository(prisma);
  const readyAt = new Date("2026-09-09T02:00:00.000Z");
  await prisma.collectorAgent.update({
    where: { id: agentId },
    data: { sessionState: "READY", sessionObservedAt: readyAt }
  });

  assert.equal(await repository.observeBlocked(
    agentId,
    "LOGIN_REQUIRED",
    new Date("2026-09-09T01:59:00.000Z")
  ), null);
  assert.equal(await prisma.collectorSessionIncident.count({ where: { collectorAgentId: agentId } }), 0);
});

test("an abandoned sending attempt becomes terminal without being claimed again", async () => {
  const openedAt = new Date("2026-09-09T03:00:00.000Z");
  await prisma.collectorAgent.update({
    where: { id: agentId },
    data: { sessionState: "LOGIN_REQUIRED", sessionObservedAt: openedAt }
  });
  const initial = new PrismaCollectorSessionIncidentRepository(prisma, () => openedAt);
  const incidentId = await initial.observeBlocked(agentId, "LOGIN_REQUIRED", openedAt);
  assert.ok(incidentId);
  assert.ok(await initial.claimPending(agentId));

  const afterTimeout = new PrismaCollectorSessionIncidentRepository(
    prisma,
    () => new Date(openedAt.getTime() + COLLECTOR_SESSION_NOTIFICATION_STALE_MILLISECONDS)
  );
  assert.equal(await afterTimeout.claimPending(agentId), null);

  const stored = await prisma.collectorSessionIncident.findUniqueOrThrow({
    where: { id: incidentId }
  });
  assert.equal(stored.notificationState, "AMBIGUOUS");
  assert.equal(stored.lastNotificationError, "WECOM_DELIVERY_AMBIGUOUS");
  assert.equal(stored.notificationAttempts, 1);
});
