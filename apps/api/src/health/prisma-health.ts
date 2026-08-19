import type { Redis } from "ioredis";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type {
  CollectionHealthRepository,
  HealthProbe,
  LatestCollectionState
} from "./health.service.ts";

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
