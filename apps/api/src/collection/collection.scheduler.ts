import { CHECK_TIMES, TIME_ZONE } from "../../../../packages/config/src/schedule.ts";

export interface CollectionSchedule {
  id: string;
  localTime: string;
  pattern: string;
  timeZone: string;
}

export interface CollectionScheduleQueue {
  upsertSchedule(schedule: CollectionSchedule): Promise<void>;
  removeSchedule(id: string): Promise<void>;
  listScheduleIds(): Promise<string[]>;
}

export interface CollectionScheduleSettings {
  enabled: boolean;
  provider: "manual" | "external" | "desktop";
  checkTimes: string[];
}

function cronPattern(localTime: string): string {
  const [hour, minute] = localTime.split(":");
  return `0 ${Number(minute)} ${Number(hour)} * * *`;
}

export class CollectionScheduler {
  private readonly queue: CollectionScheduleQueue;
  private readonly settings: () => Promise<CollectionScheduleSettings>;

  constructor(
    queue: CollectionScheduleQueue,
    settings: () => Promise<CollectionScheduleSettings> = async () => ({
      enabled: true,
      provider: "desktop",
      checkTimes: [...CHECK_TIMES]
    })
  ) {
    this.queue = queue;
    this.settings = settings;
  }

  async registerSchedules(): Promise<void> {
    const settings = await this.settings();
    const active = settings.enabled && settings.provider === "desktop";
    const existingIds = (await this.queue.listScheduleIds())
      .filter((id) => id.startsWith("tmall-collection-"));
    const desiredIds = new Set(active
      ? settings.checkTimes.map((localTime) => `tmall-collection-${localTime.replace(":", "")}`)
      : []);
    for (const id of existingIds) {
      if (!desiredIds.has(id)) await this.queue.removeSchedule(id);
    }
    if (!active) return;

    for (const localTime of settings.checkTimes) {
      const schedule = {
        id: `tmall-collection-${localTime.replace(":", "")}`,
        localTime,
        pattern: cronPattern(localTime),
        timeZone: TIME_ZONE
      };
      await this.queue.upsertSchedule(schedule);
    }
  }
}
