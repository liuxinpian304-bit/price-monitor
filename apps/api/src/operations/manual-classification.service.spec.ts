import assert from "node:assert/strict";
import test from "node:test";

import { AuditService, type AuditEntryInput, type AuditRepository } from "../audit/audit.service.ts";
import {
  ManualCandidateNotFoundError,
  ManualClassificationService,
  type ManualCandidateRecord,
  type ManualClassificationRepository
} from "./manual-classification.service.ts";

class FakeRepository implements ManualClassificationRepository {
  candidate: ManualCandidateRecord | null = {
    id: "candidate-1",
    decision: "MANUAL",
    comparable: false,
    comparisonType: "BARE",
    reasons: ["无法判断裸机或套装"]
  };

  async findById(id: string) {
    return id === this.candidate?.id ? this.candidate : null;
  }

  async updateDecision(id: string, decision: "BARE" | "BUNDLE" | "REJECTED", comparable: boolean, reasons: string[]) {
    this.candidate = { ...this.candidate!, id, decision, comparable, reasons };
    return this.candidate;
  }
}

class RecordingAuditRepository implements AuditRepository {
  entries: AuditEntryInput[] = [];

  async create(entry: AuditEntryInput) {
    this.entries.push(entry);
  }
}

function context() {
  const repository = new FakeRepository();
  const auditRepository = new RecordingAuditRepository();
  return {
    repository,
    auditRepository,
    service: new ManualClassificationService(repository, new AuditService(auditRepository))
  };
}

test("marks a matching manual candidate as comparable and records an audit entry", async () => {
  const { service, repository, auditRepository } = context();

  const updated = await service.classify("candidate-1", "BARE", "operator-1");

  assert.equal(updated.decision, "BARE");
  assert.equal(updated.comparable, true);
  assert.ok(updated.reasons.includes("运营人工分类为裸机"));
  assert.equal(repository.candidate?.decision, "BARE");
  assert.equal(auditRepository.entries[0]?.actorId, "operator-1");
  assert.equal(auditRepository.entries[0]?.action, "candidate.classified");
});

test("keeps a differently typed candidate non-comparable", async () => {
  const { service } = context();

  const updated = await service.classify("candidate-1", "BUNDLE", "operator-1");

  assert.equal(updated.comparable, false);
});

test("rejects an unknown candidate", async () => {
  const { service } = context();

  await assert.rejects(service.classify("missing", "REJECTED", "operator-1"), ManualCandidateNotFoundError);
});
