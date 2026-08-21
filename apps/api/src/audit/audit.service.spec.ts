import assert from "node:assert/strict";
import test from "node:test";

import { AuditService, type AuditEntryInput } from "./audit.service.ts";

test("records who changed an entity with before and after values", async () => {
  const entries: AuditEntryInput[] = [];
  const service = new AuditService({
    create: async (entry) => {
      entries.push(entry);
    }
  });

  await service.record({
    actorId: "operator-1",
    action: "catalog.model.updated",
    entityType: "MonitoredModel",
    entityId: "MON-0001",
    before: { enabled: true, owner: "张三" },
    after: { enabled: false, owner: "张三" }
  });

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    actorId: "operator-1",
    action: "catalog.model.updated",
    entityType: "MonitoredModel",
    entityId: "MON-0001",
    before: { enabled: true, owner: "张三" },
    after: { enabled: false, owner: "张三" }
  });
});

test("rejects an audit record without an actor", async () => {
  const service = new AuditService({ create: async () => undefined });

  await assert.rejects(
    service.record({
      actorId: "",
      action: "catalog.model.updated",
      entityType: "MonitoredModel",
      entityId: "MON-0001",
      before: null,
      after: { enabled: false }
    }),
    /actorId is required/
  );
});
