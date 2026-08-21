import { AuditService, type JsonValue } from "../audit/audit.service.ts";

export type ManualClassificationDecision = "BARE" | "BUNDLE" | "REJECTED";

export interface ManualCandidateRecord {
  id: string;
  decision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL";
  comparable: boolean;
  comparisonType: "BARE" | "BUNDLE";
  reasons: string[];
}

export interface ManualClassificationRepository {
  findById(id: string): Promise<ManualCandidateRecord | null>;
  updateDecision(
    id: string,
    decision: ManualClassificationDecision,
    comparable: boolean,
    reasons: string[]
  ): Promise<ManualCandidateRecord>;
}

export class ManualCandidateNotFoundError extends Error {}
export class ManualClassificationValidationError extends Error {}

const LABELS: Record<ManualClassificationDecision, string> = {
  BARE: "裸机",
  BUNDLE: "套装",
  REJECTED: "排除"
};

function asJson(record: ManualCandidateRecord): JsonValue {
  return JSON.parse(JSON.stringify(record)) as JsonValue;
}

export class ManualClassificationService {
  private readonly repository: ManualClassificationRepository;
  private readonly audit: AuditService;

  constructor(repository: ManualClassificationRepository, audit: AuditService) {
    this.repository = repository;
    this.audit = audit;
  }

  async classify(
    id: string,
    decision: ManualClassificationDecision,
    actorId: string
  ): Promise<ManualCandidateRecord> {
    if (!Object.hasOwn(LABELS, decision)) {
      throw new ManualClassificationValidationError("分类结果只能是裸机、套装或排除");
    }
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new ManualCandidateNotFoundError(`待分类商品“${id}”不存在`);
    }

    const comparable = decision !== "REJECTED" && decision === existing.comparisonType;
    const reasons = [
      ...existing.reasons.filter((reason) => !reason.startsWith("运营人工分类为")),
      `运营人工分类为${LABELS[decision]}`
    ];
    const updated = await this.repository.updateDecision(id, decision, comparable, reasons);
    await this.audit.record({
      actorId,
      action: "candidate.classified",
      entityType: "SearchCandidate",
      entityId: id,
      before: asJson(existing),
      after: asJson(updated)
    });
    return updated;
  }
}
