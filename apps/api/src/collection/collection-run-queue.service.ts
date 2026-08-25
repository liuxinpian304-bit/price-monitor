import { Prisma, type PrismaClient } from "../../../../generated/prisma/client.ts";

export type QueueableCollectionStatus =
  | "QUEUED"
  | "RUNNING"
  | "PAUSED_LOGIN"
  | "PAUSED_CHALLENGE"
  | "COALESCED"
  | "SUCCEEDED"
  | "PARTIAL_FAILED"
  | "FAILED";

export interface QueuedCollectionRun {
  id: string;
  monitoredModelId: string;
  providerKey: "taobao-desktop";
  scheduledFor: Date;
  searchLimit: number;
  status: QueueableCollectionStatus;
  coalescedIntoRunId: string | null;
  actorId: string | null;
}

export interface CollectionRunQueueRepository {
  listEnabledModels(): Promise<Array<{ id: string; enabled: boolean }>>;
  getEnabledModel(modelId: string): Promise<{ id: string; enabled: boolean } | null>;
  createOrCoalesce(input: {
    monitoredModelId: string;
    providerKey: "taobao-desktop";
    scheduledFor: Date;
    searchLimit: number;
    actorId: string | null;
  }): Promise<{ run: QueuedCollectionRun; coalesced: boolean }>;
  requeuePaused(runId: string): Promise<QueuedCollectionRun | null>;
}

export class CollectionRunModelNotFoundError extends Error {
  constructor() {
    super("监控型号不存在或已停用");
    this.name = "CollectionRunModelNotFoundError";
  }
}

export class CollectionRunNotPausedError extends Error {
  constructor() {
    super("只有已暂停的桌面采集任务可以重试");
    this.name = "CollectionRunNotPausedError";
  }
}

function validateSearchLimit(searchLimit: number): void {
  if (!Number.isInteger(searchLimit) || searchLimit < 1 || searchLimit > 50) {
    throw new RangeError("searchLimit 必须是 1 到 50 的整数");
  }
}

export class CollectionRunQueueService {
  private readonly repository: CollectionRunQueueRepository;

  constructor(repository: CollectionRunQueueRepository) {
    this.repository = repository;
  }

  async enqueueEnabledModels(scheduledFor: Date): Promise<Array<{ run: QueuedCollectionRun; coalesced: boolean }>> {
    const models = await this.repository.listEnabledModels();
    return Promise.all(models.map((model) => this.repository.createOrCoalesce({
      monitoredModelId: model.id,
      providerKey: "taobao-desktop",
      scheduledFor,
      searchLimit: 50,
      actorId: null
    })));
  }

  async enqueueModelNow(
    monitoredModelId: string,
    actorId: string,
    searchLimit = 50,
    scheduledFor = new Date()
  ): Promise<{ runId: string; coalesced: boolean }> {
    validateSearchLimit(searchLimit);
    if (!await this.repository.getEnabledModel(monitoredModelId)) {
      throw new CollectionRunModelNotFoundError();
    }
    const created = await this.repository.createOrCoalesce({
      monitoredModelId,
      providerKey: "taobao-desktop",
      scheduledFor,
      searchLimit,
      actorId
    });
    return { runId: created.run.id, coalesced: created.coalesced };
  }

  async requeuePausedRun(runId: string): Promise<{ runId: string }> {
    const run = await this.repository.requeuePaused(runId);
    if (!run) throw new CollectionRunNotPausedError();
    return { runId: run.id };
  }
}

function toQueuedRun(run: {
  id: string;
  monitoredModelId: string;
  providerKey: string;
  scheduledFor: Date;
  searchLimit: number;
  status: QueueableCollectionStatus;
  coalescedIntoRunId: string | null;
}): QueuedCollectionRun {
  return {
    ...run,
    providerKey: "taobao-desktop",
    actorId: null
  };
}

const unfinishedStatuses = ["QUEUED", "RUNNING", "PAUSED_LOGIN", "PAUSED_CHALLENGE"] as const;
const maximumCreateAttempts = 5;

function hasPrismaErrorCode(error: unknown, code: "P2002" | "P2034"): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

export class PrismaCollectionRunQueueRepository implements CollectionRunQueueRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listEnabledModels(): Promise<Array<{ id: string; enabled: boolean }>> {
    return this.prisma.monitoredModel.findMany({
      where: { enabled: true },
      select: { id: true, enabled: true },
      orderBy: { id: "asc" }
    });
  }

  async getEnabledModel(modelId: string): Promise<{ id: string; enabled: boolean } | null> {
    return this.prisma.monitoredModel.findFirst({
      where: { id: modelId, enabled: true },
      select: { id: true, enabled: true }
    });
  }

  async createOrCoalesce(input: {
    monitoredModelId: string;
    providerKey: "taobao-desktop";
    scheduledFor: Date;
    searchLimit: number;
    actorId: string | null;
  }): Promise<{ run: QueuedCollectionRun; coalesced: boolean }> {
    void input.actorId;
    for (let attempt = 0; attempt < maximumCreateAttempts; attempt += 1) {
      try {
        return await this.createOrCoalesceInSerializableTransaction(input);
      } catch (error) {
        if (!hasPrismaErrorCode(error, "P2002") && !hasPrismaErrorCode(error, "P2034")) {
          throw error;
        }

        const sameSlot = await this.findSameSlot(input);
        if (sameSlot) {
          return { run: toQueuedRun(sameSlot), coalesced: sameSlot.status === "COALESCED" };
        }
        if (attempt === maximumCreateAttempts - 1) throw error;
      }
    }
    throw new Error("unreachable collection run retry state");
  }

  private async findSameSlot(input: {
    monitoredModelId: string;
    providerKey: "taobao-desktop";
    scheduledFor: Date;
  }) {
    return this.prisma.collectionRun.findUnique({
      where: {
        monitoredModelId_providerKey_scheduledFor: {
          monitoredModelId: input.monitoredModelId,
          providerKey: input.providerKey,
          scheduledFor: input.scheduledFor
        }
      },
      select: {
        id: true, monitoredModelId: true, providerKey: true, scheduledFor: true,
        searchLimit: true, status: true, coalescedIntoRunId: true
      }
    });
  }

  private async createOrCoalesceInSerializableTransaction(input: {
    monitoredModelId: string;
    providerKey: "taobao-desktop";
    scheduledFor: Date;
    searchLimit: number;
    actorId: string | null;
  }): Promise<{ run: QueuedCollectionRun; coalesced: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "MonitoredModel"
        WHERE "id" = ${input.monitoredModelId} AND "enabled" = true
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new CollectionRunModelNotFoundError();

      const sameSlot = await transaction.collectionRun.findUnique({
        where: {
          monitoredModelId_providerKey_scheduledFor: {
            monitoredModelId: input.monitoredModelId,
            providerKey: input.providerKey,
            scheduledFor: input.scheduledFor
          }
        },
        select: {
          id: true, monitoredModelId: true, providerKey: true, scheduledFor: true,
          searchLimit: true, status: true, coalescedIntoRunId: true
        }
      });
      if (sameSlot) {
        return { run: toQueuedRun(sameSlot), coalesced: sameSlot.status === "COALESCED" };
      }

      const active = await transaction.collectionRun.findFirst({
        where: { monitoredModelId: input.monitoredModelId, status: { in: [...unfinishedStatuses] } },
        orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      const run = await transaction.collectionRun.create({
        data: {
          monitoredModelId: input.monitoredModelId,
          providerKey: input.providerKey,
          scheduledFor: input.scheduledFor,
          searchLimit: input.searchLimit,
          status: active ? "COALESCED" : "QUEUED",
          coalescedIntoRunId: active?.id ?? null
        },
        select: {
          id: true, monitoredModelId: true, providerKey: true, scheduledFor: true,
          searchLimit: true, status: true, coalescedIntoRunId: true
        }
      });
      return { run: toQueuedRun(run), coalesced: Boolean(active) };
    }, { isolationLevel: "Serializable" });
  }

  async requeuePaused(runId: string): Promise<QueuedCollectionRun | null> {
    const updated = await this.prisma.collectionRun.updateMany({
      where: {
        id: runId,
        providerKey: "taobao-desktop",
        status: { in: ["PAUSED_LOGIN", "PAUSED_CHALLENGE"] },
        coalescedIntoRunId: null
      },
      data: { status: "QUEUED", errorCode: null, errorMessage: null }
    });
    if (updated.count !== 1) return null;
    const run = await this.prisma.collectionRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        id: true, monitoredModelId: true, providerKey: true, scheduledFor: true,
        searchLimit: true, status: true, coalescedIntoRunId: true
      }
    });
    return toQueuedRun(run);
  }
}
