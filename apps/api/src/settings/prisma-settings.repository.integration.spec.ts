import "dotenv/config";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { createPrismaClient } from "../database/prisma.service.ts";
import type { AtomicWecomLiveSendApprovalInput } from "./settings.service.ts";
import { PrismaSettingsRepository } from "./prisma-settings.repository.ts";

const APPROVAL_KEY = "WECOM_LIVE_SEND_APPROVAL";
const prisma = createPrismaClient();

function approvalInput(
  actorId: string,
  previewRunId: string,
  previewDigest: string,
  action = "wecom.live-send.approved"
): AtomicWecomLiveSendApprovalInput {
  return {
    setting: {
      key: APPROVAL_KEY,
      valueJson: {
        approved: true,
        actorId,
        approvedAt: "2026-08-28T02:30:00.000Z",
        previewRunId,
        previewDigest
      },
      encryptedValue: null,
      secret: false,
      updatedBy: actorId
    },
    audit: {
      actorId,
      action,
      entityType: "SystemSetting",
      entityId: APPROVAL_KEY
    }
  };
}

async function clearApproval(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { entityType: "SystemSetting", entityId: APPROVAL_KEY }
  });
  await prisma.systemSetting.deleteMany({ where: { key: APPROVAL_KEY } });
}

before(async () => {
  await prisma.$connect();
});

beforeEach(clearApproval);

after(async () => {
  await clearApproval();
  await prisma.$disconnect();
});

test("atomically preserves one approval and audit when the setting row is initially absent", async () => {
  const repository = new PrismaSettingsRepository(prisma);
  const first = approvalInput("admin-1", "run-1", `sha256:${"a".repeat(64)}`);
  const second = approvalInput("admin-2", "run-2", `sha256:${"b".repeat(64)}`);

  const results = await Promise.all([
    repository.compareAndSetWecomLiveSendApproval(first),
    repository.compareAndSetWecomLiveSendApproval(second)
  ]);

  assert.deepEqual(results.sort(), ["ALREADY_APPROVED", "APPROVED"]);
  const setting = await prisma.systemSetting.findUniqueOrThrow({ where: { key: APPROVAL_KEY } });
  const audits = await prisma.auditLog.findMany({
    where: { entityType: "SystemSetting", entityId: APPROVAL_KEY }
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorId, setting.updatedBy);
  assert.deepEqual(audits[0]!.after, setting.valueJson);
  assert.equal(audits[0]!.before, null);
});

test("rolls back the approval setting when the audit insert fails", async () => {
  const repository = new PrismaSettingsRepository(prisma);
  const input = approvalInput(
    "admin-1",
    "run-1",
    `sha256:${"a".repeat(64)}`,
    "x".repeat(201)
  );

  await assert.rejects(() => repository.compareAndSetWecomLiveSendApproval(input));

  assert.equal(await prisma.systemSetting.findUnique({ where: { key: APPROVAL_KEY } }), null);
  assert.equal(await prisma.auditLog.count({
    where: { entityType: "SystemSetting", entityId: APPROVAL_KEY }
  }), 0);
});
