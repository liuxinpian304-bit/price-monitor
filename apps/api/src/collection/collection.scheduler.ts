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
}

export interface CollectionScheduleSettings {
  enabled: boolean;
  provider: "manual" | "external" | "desktop";
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
    settings: () => Promise<CollectionScheduleSettings> = async () => ({ enabled: true, provider: "desktop" })
  ) {
    this.queue = queue;
    this.settings = settings;
  }

  async registerSchedules(): Promise<void> {
    const settings = await this.settings();
    const active = settings.enabled && settings.provider === "desktop";
    for (const localTime of CHECK_TIMES) {
      const schedule = {
        id: `tmall-collection-${localTime.replace(":", "")}`,
        localTime,
        pattern: cronPattern(localTime),
        timeZone: TIME_ZONE
      };
      if (active) {
        await this.queue.upsertSchedule(schedule);
      } else {
        await this.queue.removeSchedule(schedule.id);
      }
    }
  }
}
