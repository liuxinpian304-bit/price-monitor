export interface HealthProbe {
  ping(): Promise<boolean>;
}

export interface LatestCollectionState {
  status: string;
  finishedAt: Date | null;
}

export interface CollectionHealthRepository {
  latest(): Promise<LatestCollectionState | null>;
}

export interface HealthResult {
  status: "ok" | "degraded";
  database: "up" | "down";
  redis: "up" | "down";
  collection: { status: string; finishedAt: string | null };
  checkedAt: string;
}

async function safePing(probe: HealthProbe): Promise<boolean> {
  try {
    return await probe.ping();
  } catch {
    return false;
  }
}

export class HealthService {
  private readonly database: HealthProbe;
  private readonly redis: HealthProbe;
  private readonly collections: CollectionHealthRepository;

  constructor(database: HealthProbe, redis: HealthProbe, collections: CollectionHealthRepository) {
    this.database = database;
    this.redis = redis;
    this.collections = collections;
  }

  async getHealth(): Promise<HealthResult> {
    const [databaseUp, redisUp, latest] = await Promise.all([
      safePing(this.database),
      safePing(this.redis),
      this.collections.latest().catch(() => null)
    ]);
    return {
      status: databaseUp && redisUp ? "ok" : "degraded",
      database: databaseUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
      collection: {
        status: latest?.status ?? "NO_RUN",
        finishedAt: latest?.finishedAt?.toISOString() ?? null
      },
      checkedAt: new Date().toISOString()
    };
  }
}
