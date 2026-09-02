import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";
import { PrismaAlertRepository } from "../alerts/prisma-alert.repository.ts";
import { runAlertSummaryToJson } from "../alerts/run-alert-summary.persistence.ts";
import type {
  BaselineIssueCode,
  CandidateMatchPersistence,
  RunAlertBundleComponent,
  RunAlertData,
  RunAlertRepository,
  RunAlertSummary,
  RunAlertUnitOfWork,
  SnapshotCombinationPersistence,
  SnapshotMatchPersistence
} from "./run-alert.service.ts";
import { deriveOwnCatalogCompleteness } from "./own-catalog-completeness.ts";

type Transaction = Prisma.TransactionClient;

export class RunAlertEvaluationError extends Error {
  constructor() {
    super("Run alert evaluation is unavailable");
    this.name = "RunAlertEvaluationError";
  }
}

function isTerminal(
  status: string
): status is RunAlertData["status"] {
  return status === "SUCCEEDED" || status === "PARTIAL_FAILED" || status === "FAILED";
}

function attributesFromJson(value: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const attributes = Reflect.get(value, "attributes");
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return {};
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function skuComponentsFromJson(value: Prisma.JsonValue | null): RunAlertBundleComponent[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const components = Reflect.get(value, "components");
  if (!Array.isArray(components) || components.length === 0) return null;
  const parsed: RunAlertBundleComponent[] = [];
  for (const component of components) {
    if (!component || typeof component !== "object" || Array.isArray(component)) return null;
    const role = Reflect.get(component, "role");
    const accessoryType = Reflect.get(component, "accessoryType");
    const brand = Reflect.get(component, "brand");
    const modelOrName = Reflect.get(component, "modelOrName");
    const quantity = Reflect.get(component, "quantity");
    if (
      (role !== "CORE"
        && role !== "PAID_ACCESSORY"
        && role !== "GIFT_OR_SERVICE"
        && role !== "UNKNOWN")
      || typeof accessoryType !== "string"
      || accessoryType.trim().length === 0
      || (brand !== null && typeof brand !== "string")
      || (typeof brand === "string" && brand.trim().length === 0)
      || typeof modelOrName !== "string"
      || modelOrName.trim().length === 0
      || typeof quantity !== "number"
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
    ) {
      return null;
    }
    parsed.push({ role, accessoryType, brand, modelOrName, quantity });
  }
  return parsed;
}

function issueKey(runId: string, code: BaselineIssueCode): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, "run-alert-baseline", code]))
    .digest("hex");
  return `sha256:${digest}`;
}

function issueMessage(code: BaselineIssueCode): string {
  return code === "OWN_BASELINE_MISSING"
    ? "Authoritative own SKU baseline is missing or unavailable"
    : "Authoritative own SKU baseline has multiple eligible matches";
}

class PrismaRunAlertUnitOfWork implements RunAlertUnitOfWork {
  readonly data: RunAlertData;
  readonly alerts: PrismaAlertRepository;
  private readonly transaction: Transaction;

  constructor(transaction: Transaction, data: RunAlertData) {
    this.transaction = transaction;
    this.data = data;
    this.alerts = new PrismaAlertRepository(transaction);
  }

  async saveSnapshotDecisions(decisions: SnapshotMatchPersistence[]): Promise<void> {
    for (const decision of decisions) {
      const updated = await this.transaction.offerSnapshot.updateMany({
        where: { id: decision.snapshotId, collectionRunId: this.data.runId },
        data: {
          matchDecision: decision.decision,
          comparable: decision.comparable,
          matchConfidenceBps: decision.confidenceBps,
          normalizedModel: decision.normalizedModel,
          matchReasons: decision.reasons
        }
      });
      if (updated.count !== 1) throw new RunAlertEvaluationError();
    }
  }

  async saveCombinationDecisions(decisions: SnapshotCombinationPersistence[]): Promise<void> {
    const referencedSnapshotIds = [...new Set(decisions.flatMap((decision) => [
      decision.snapshotId,
      ...(decision.comparisonOwnSnapshotId === null ? [] : [decision.comparisonOwnSnapshotId])
    ]))];
    const snapshotsInRun = await this.transaction.offerSnapshot.findMany({
      where: {
        id: { in: referencedSnapshotIds },
        collectionRunId: this.data.runId
      },
      select: { id: true }
    });
    if (snapshotsInRun.length !== referencedSnapshotIds.length) {
      throw new RunAlertEvaluationError();
    }
    for (const decision of decisions) {
      const updated = await this.transaction.offerSnapshot.updateMany({
        where: { id: decision.snapshotId, collectionRunId: this.data.runId },
        data: {
          combinationSignature: decision.signature,
          combinationLabel: decision.label,
          combinationState: decision.state,
          combinationReasons: {
            ruleVersion: decision.reasons.ruleVersion,
            codes: [...decision.reasons.codes]
          },
          comparisonOwnSnapshotId: decision.comparisonOwnSnapshotId
        }
      });
      if (updated.count !== 1) throw new RunAlertEvaluationError();
    }
  }

  async saveCandidateDecisions(decisions: CandidateMatchPersistence[]): Promise<void> {
    for (const decision of decisions) {
      const updated = await this.transaction.searchCandidate.updateMany({
        where: { id: decision.candidateId, monitoredModelId: this.data.model.id },
        data: {
          decision: decision.decision,
          comparable: decision.comparable,
          confidenceBps: decision.confidenceBps,
          normalizedModel: decision.normalizedModel,
          reasons: decision.reasons
        }
      });
      if (updated.count !== 1) throw new RunAlertEvaluationError();
    }
  }

  async saveOwnBaselineSnapshot(snapshotId: string | null): Promise<void> {
    if (snapshotId !== null) {
      const snapshot = await this.transaction.offerSnapshot.count({
        where: { id: snapshotId, collectionRunId: this.data.runId }
      });
      if (snapshot !== 1) throw new RunAlertEvaluationError();
    }
    await this.transaction.collectionRun.update({
      where: { id: this.data.runId },
      data: { ownBaselineSnapshotId: snapshotId }
    });
  }

  async ensureBaselineIssue(code: BaselineIssueCode): Promise<boolean> {
    const created = await this.transaction.collectionIssue.createMany({
      data: [{
        collectionRunId: this.data.runId,
        issueKey: issueKey(this.data.runId, code),
        code,
        message: issueMessage(code),
        capturedAt: this.data.completedAt
      }],
      skipDuplicates: true
    });
    if (created.count === 1) {
      await this.transaction.collectionRun.update({
        where: { id: this.data.runId },
        data: {
          failedCount: { increment: 1 },
          incompleteCount: { increment: 1 }
        }
      });
      return true;
    }
    return false;
  }

  async ensureNotificationBatch(summary: RunAlertSummary): Promise<void> {
    if (summary.runId !== this.data.runId) throw new RunAlertEvaluationError();
    await this.transaction.runAlertNotificationBatch.createMany({
      data: [{
        collectionRunId: summary.runId,
        summary: runAlertSummaryToJson(summary),
        alertIds: summary.alerts.map((alert) => alert.alertId)
      }],
      skipDuplicates: true
    });
  }
}

export class PrismaRunAlertRepository implements RunAlertRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async withEvaluation<T>(
    runId: string,
    operation: (unit: RunAlertUnitOfWork) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "CollectionRun"
        WHERE "id" = ${runId}
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new RunAlertEvaluationError();

      const run = await transaction.collectionRun.findUniqueOrThrow({
        where: { id: runId },
        select: {
          id: true,
          monitoredModelId: true,
          status: true,
          claimedOwnListingIds: true,
          searchLimit: true,
          skuCount: true,
          finishedAt: true,
          createdAt: true
        }
      });
      if (!isTerminal(run.status)) throw new RunAlertEvaluationError();

      const model = await transaction.monitoredModel.findUniqueOrThrow({
        where: { id: run.monitoredModelId }
      });
      const aliases = await transaction.modelAlias.findMany({
        where: { monitoredModelId: model.id },
        select: { phrase: true, type: true }
      });
      const bundleItems = model.bundleId
        ? await transaction.bundleItem.findMany({
            where: { bundleId: model.bundleId },
            select: {
              accessoryType: true,
              brand: true,
              modelOrName: true,
              quantity: true,
              core: true
            }
          })
        : [];
      const snapshots = await transaction.offerSnapshot.findMany({
        where: { collectionRunId: run.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      });
      const ownListings = await transaction.ownListing.findMany({
        where: {
          id: {
            in: [...new Set([
              ...run.claimedOwnListingIds,
              ...snapshots.flatMap((snapshot) => snapshot.ownListingId ? [snapshot.ownListingId] : [])
            ])]
          }
        },
        select: { id: true, platformItemId: true, skuText: true, url: true }
      });
      const candidates = await transaction.searchCandidate.findMany({
        where: {
          id: {
            in: snapshots.flatMap(
              (snapshot) => snapshot.searchCandidateId ? [snapshot.searchCandidateId] : []
            )
          }
        },
        select: { id: true, url: true }
      });
      const positions = await transaction.collectionSearchPosition.findMany({
        where: { collectionRunId: run.id },
        select: { platformItemId: true, rank: true },
        orderBy: { rank: "asc" }
      });
      const issues = await transaction.collectionIssue.findMany({
        where: { collectionRunId: run.id },
        select: { code: true, platformItemId: true, skuId: true }
      });

      const ranks = new Map<string, number[]>();
      for (const position of positions) {
        const current = ranks.get(position.platformItemId) ?? [];
        current.push(position.rank);
        ranks.set(position.platformItemId, current);
      }
      const ownListingById = new Map(ownListings.map((listing) => [listing.id, listing]));
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const ownCatalogCompleteness = deriveOwnCatalogCompleteness({
        claimedOwnListings: run.claimedOwnListingIds.map((id) => {
          const listing = ownListingById.get(id);
          return { id, platformItemId: listing?.platformItemId ?? null };
        }),
        ownSnapshots: snapshots.map((snapshot) => ({
          ownListingId: snapshot.ownListingId,
          platformItemId: snapshot.platformItemId,
          skuId: snapshot.skuId
        })),
        issues
      });
      const data: RunAlertData = {
        runId: run.id,
        status: run.status,
        searchLimit: run.searchLimit,
        positionCount: positions.length,
        skuCount: run.skuCount,
        issueCount: issues.length,
        completedAt: run.finishedAt ?? run.createdAt,
        claimedOwnListingIds: [...run.claimedOwnListingIds],
        ownCatalogComplete: ownCatalogCompleteness.complete,
        model: {
          id: model.id,
          brand: model.brand,
          standardModel: model.standardModel,
          version: model.version,
          comparisonType: model.comparisonType,
          colorComparable: model.colorComparable,
          owner: model.owner,
          effectiveAliases: aliases
            .filter((alias) => alias.type === "EFFECTIVE")
            .map((alias) => alias.phrase),
          excludedAliases: aliases
            .filter((alias) => alias.type === "EXCLUDED")
            .map((alias) => alias.phrase),
          mustIncludeTerms: model.mustIncludeTerms,
          excludedTerms: model.excludedTerms,
          bundleItems
        },
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id,
          ownListingId: snapshot.ownListingId,
          ownListingSkuText: snapshot.ownListingId
            ? ownListingById.get(snapshot.ownListingId)?.skuText ?? null
            : null,
          searchCandidateId: snapshot.searchCandidateId,
          platformItemId: snapshot.platformItemId,
          skuId: snapshot.skuId ?? "",
          shopName: snapshot.shopName,
          title: snapshot.title,
          skuText: snapshot.skuText ?? "",
          attributes: attributesFromJson(snapshot.rawEvidence),
          components: skuComponentsFromJson(snapshot.rawEvidence),
          listPriceFen: snapshot.listPriceFen ?? snapshot.payableFen ?? 0,
          activityPriceFen: snapshot.activityPriceFen ?? snapshot.payableFen ?? 0,
          publicDiscountFen: snapshot.publicDiscountFen,
          payableFen: snapshot.payableFen,
          priceConfidence: snapshot.priceConfidence,
          stockState: snapshot.stockState,
          capturedAt: snapshot.capturedAt,
          url: snapshot.ownListingId
            ? ownListingById.get(snapshot.ownListingId)?.url ?? snapshot.evidenceUrl ?? ""
            : snapshot.searchCandidateId
              ? candidateById.get(snapshot.searchCandidateId)?.url ?? snapshot.evidenceUrl ?? ""
              : snapshot.evidenceUrl ?? "",
          searchRanks: ranks.get(snapshot.platformItemId) ?? []
        }))
      };

      return await operation(new PrismaRunAlertUnitOfWork(transaction, data));
    }, { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 30_000 });
  }
}
