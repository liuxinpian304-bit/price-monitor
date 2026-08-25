import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

import type { CollectionLock } from "./collection.service.ts";
import type { CollectionSchedule, CollectionScheduleQueue } from "./collection.scheduler.ts";
import type { CollectionRunQueueService } from "./collection-run-queue.service.ts";

export interface ScheduledCollectionJob {
  scheduledLocalTime: string;
  timeZone: string;
}

export class BullMqCollectionScheduleQueue implements CollectionScheduleQueue {
  private readonly queue: Queue<ScheduledCollectionJob>;

  constructor(queue: Queue<ScheduledCollectionJob>) {
    this.queue = queue;
  }

  async upsertSchedule(schedule: CollectionSchedule): Promise<void> {
    await this.queue.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.pattern, tz: schedule.timeZone },
      {
        name: "collect-all-monitored-models",
        data: {
          scheduledLocalTime: schedule.localTime,
          timeZone: schedule.timeZone
        },
        opts: {
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 500
        }
      }
    );
  }

  async removeSchedule(id: string): Promise<void> {
    await this.queue.removeJobScheduler(id);
  }

  async listScheduleIds(): Promise<string[]> {
    const schedulers = await this.queue.getJobSchedulers(0, -1, true);
    return schedulers.map((scheduler) => scheduler.key);
  }
}

export interface ScheduledClockJob {
  timestamp: number;
}

export class CollectionScheduleProcessor {
  private readonly collectionRuns: Pick<CollectionRunQueueService, "enqueueEnabledModels">;
  private readonly settings: () => Promise<{ enabled: boolean; provider: "manual" | "external" | "desktop" }>;

  constructor(
    collectionRuns: Pick<CollectionRunQueueService, "enqueueEnabledModels">,
    settings: () => Promise<{ enabled: boolean; provider: "manual" | "external" | "desktop" }>
      = async () => ({ enabled: true, provider: "desktop" })
  ) {
    this.collectionRuns = collectionRuns;
    this.settings = settings;
  }

  async process(job: ScheduledClockJob): Promise<void> {
    const settings = await this.settings();
    if (!settings.enabled || settings.provider !== "desktop") return;
    await this.collectionRuns.enqueueEnabledModels(new Date(job.timestamp));
  }
}

export class RedisCollectionLock implements CollectionLock {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async acquire(key: string, ttlMilliseconds: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, "PX", ttlMilliseconds, "NX");
    return result === "OK" ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token
    );
  }
}
