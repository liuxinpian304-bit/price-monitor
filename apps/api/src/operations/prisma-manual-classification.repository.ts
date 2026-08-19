import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

import type {
  ManualCandidateRecord,
  ManualClassificationDecision,
  ManualClassificationRepository
} from "./manual-classification.service.ts";

function reasonsFromJson(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class PrismaManualClassificationRepository implements ManualClassificationRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async findById(id: string): Promise<ManualCandidateRecord | null> {
    const candidate = await this.prisma.searchCandidate.findUnique({
      where: { id },
      include: { monitoredModel: { select: { comparisonType: true } } }
    });
    return candidate ? {
      id: candidate.id,
      decision: candidate.decision,
      comparable: candidate.comparable,
      comparisonType: candidate.monitoredModel.comparisonType,
      reasons: reasonsFromJson(candidate.reasons)
    } : null;
  }

  async updateDecision(
    id: string,
    decision: ManualClassificationDecision,
    comparable: boolean,
    reasons: string[]
  ): Promise<ManualCandidateRecord> {
    const candidate = await this.prisma.searchCandidate.update({
      where: { id },
      data: { decision, comparable, reasons },
      include: { monitoredModel: { select: { comparisonType: true } } }
    });
    return {
      id: candidate.id,
      decision: candidate.decision,
      comparable: candidate.comparable,
      comparisonType: candidate.monitoredModel.comparisonType,
      reasons: reasonsFromJson(candidate.reasons)
    };
  }
}
