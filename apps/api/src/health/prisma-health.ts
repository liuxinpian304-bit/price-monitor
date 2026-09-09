import type { Redis } from "ioredis";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type {
  CollectionHealthRepository,
  HealthProbe,
  LatestCollectionState
} from "./health.service.ts";

// The collector polls for work every 30 seconds; five minutes tolerates brief delays.
// This reports recent agent activity only, not login or challenge readiness.
export const COLLECTOR_AGENT_HEALTH_FRESHNESS_MILLISECONDS = 5 * 60_000;

export class PrismaDatabaseProbe implements HealthProbe {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async ping(): Promise<boolean> {
    await this.prisma.$queryRawUnsafe("SELECT 1");
    return true;
  }
}

export class RedisHealthProbe implements HealthProbe {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async ping(): Promise<boolean> {
    return await this.redis.ping() === "PONG";
  }
}

export class PrismaCollectionHealthRepository implements CollectionHealthRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async latest(): Promise<LatestCollectionState | null> {
    return this.prisma.collectionRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { status: true, finishedAt: true }
    });
  }
}

export class PrismaCollectorAgentHealthProbe implements HealthProbe {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, now: () => Date = () => new Date()) {
    this.prisma = prisma;
    this.now = now;
  }

  async ping(): Promise<boolean> {
    const agent = await this.prisma.collectorAgent.findFirst({
      where: {
        enabled: true,
        lastSeenAt: {
          gte: new Date(this.now().getTime() - COLLECTOR_AGENT_HEALTH_FRESHNESS_MILLISECONDS)
        }
      },
      select: { id: true }
    });
    return Boolean(agent);
  }
}
