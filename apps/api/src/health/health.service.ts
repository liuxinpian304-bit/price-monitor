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
  queue: "up" | "down";
  collectorAgent: "up" | "down";
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
  private readonly queue: HealthProbe;
  private readonly collectorAgent: HealthProbe;

  constructor(
    database: HealthProbe,
    redis: HealthProbe,
    collections: CollectionHealthRepository,
    queue: HealthProbe = redis,
    collectorAgent: HealthProbe = { ping: async () => true }
  ) {
    this.database = database;
    this.redis = redis;
    this.collections = collections;
    this.queue = queue;
    this.collectorAgent = collectorAgent;
  }

  async getHealth(): Promise<HealthResult> {
    const [databaseUp, redisUp, latest, queueUp, collectorAgentUp] = await Promise.all([
      safePing(this.database),
      safePing(this.redis),
      this.collections.latest().catch(() => null),
      safePing(this.queue),
      safePing(this.collectorAgent)
    ]);
    return {
      status: databaseUp && redisUp && queueUp && collectorAgentUp ? "ok" : "degraded",
      database: databaseUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
      queue: queueUp ? "up" : "down",
      collectorAgent: collectorAgentUp ? "up" : "down",
      collection: {
        status: latest?.status ?? "NO_RUN",
        finishedAt: latest?.finishedAt?.toISOString() ?? null
      },
      checkedAt: new Date().toISOString()
    };
  }
}
