import assert from "node:assert/strict";
import test from "node:test";

import { AuditService, type AuditEntryInput } from "../audit/audit.service.ts";
import {
  AlertActionConflictError,
  AlertActionService,
  type AlertActionRecord,
  type NewAlertAction,
  type AlertActionRepository,
  type AlertStateRecord
} from "./alert-action.service.ts";

class FakeRepository implements AlertActionRepository {
  alert: AlertStateRecord = { id: "alert-1", status: "PENDING" };
  actions: AlertActionRecord[] = [];

  async listAlerts() { return [this.alert]; }
  async findAlertById(id: string) { return id === this.alert.id ? { ...this.alert } : null; }
  async listActions() { return this.actions; }
  async applyAction(alertId: string, input: NewAlertAction) {
    const action = {
      ...input,
      id: `action-${this.actions.length + 1}`,
      alertId,
      createdAt: new Date("2026-08-19T02:00:00.000Z")
    };
    this.actions.push(action);
    this.alert = { ...this.alert, status: input.status };
    return { ...this.alert };
  }
}

function context() {
  const repository = new FakeRepository();
  const audits: AuditEntryInput[] = [];
  const audit = new AuditService({ create: async (entry) => { audits.push(entry); } });
  return { repository, audits, service: new AlertActionService(repository, audit) };
}

for (const status of ["PRICE_CHANGED", "NO_FOLLOW", "FALSE_POSITIVE", "WATCHING"] as const) {
  test(`allows PENDING to transition to ${status}`, async () => {
    const { service, repository } = context();
    const reasonCode = status === "NO_FOLLOW" || status === "FALSE_POSITIVE" ? "TEST_REASON" : undefined;

    const updated = await service.applyAction("alert-1", {
      status,
      ...(reasonCode ? { reasonCode } : {}),
      note: "运营处理"
    }, "operator-1");

    assert.equal(updated.status, status);
    assert.equal(repository.actions.length, 1);
  });
}

test("allows WATCHING to return to PENDING", async () => {
  const { service, repository } = context();
  repository.alert.status = "WATCHING";

  assert.equal((await service.applyAction("alert-1", { status: "PENDING" }, "operator-1")).status, "PENDING");
});

test("requires a reason for NO_FOLLOW and FALSE_POSITIVE", async () => {
  const { service } = context();

  await assert.rejects(
    service.applyAction("alert-1", { status: "NO_FOLLOW" }, "operator-1"),
    /原因/
  );
  await assert.rejects(
    service.applyAction("alert-1", { status: "FALSE_POSITIVE" }, "operator-1"),
    /原因/
  );
});

test("rejects changes from a terminal state", async () => {
  const { service, repository } = context();
  repository.alert.status = "PRICE_CHANGED";

  await assert.rejects(
    service.applyAction("alert-1", { status: "WATCHING" }, "operator-1"),
    AlertActionConflictError
  );
});

test("records action history and a before/after audit entry", async () => {
  const { service, audits } = context();

  await service.applyAction("alert-1", {
    status: "NO_FOLLOW",
    reasonCode: "BELOW_MARGIN",
    note: "低于利润底线"
  }, "operator-9");

  const history = await service.listActions("alert-1");
  assert.equal(history[0]?.actorId, "operator-9");
  assert.equal(history[0]?.reasonCode, "BELOW_MARGIN");
  assert.equal(audits[0]?.actorId, "operator-9");
  assert.deepEqual(audits[0]?.before, { status: "PENDING" });
  assert.deepEqual(audits[0]?.after, { status: "NO_FOLLOW" });
});
