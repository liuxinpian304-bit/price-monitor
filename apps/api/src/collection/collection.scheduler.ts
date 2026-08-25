import { CHECK_TIMES, TIME_ZONE } from "../../../../packages/config/src/schedule.ts";

export interface CollectionSchedule {
  id: string;
  localTime: string;
  pattern: string;
  timeZone: string;
}

export interface CollectionScheduleQueue {
  upsertSchedule(schedule: CollectionSchedule): Promise<void>;
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
    if (!settings.enabled || settings.provider !== "desktop") return;
    for (const localTime of CHECK_TIMES) {
      await this.queue.upsertSchedule({
        id: `tmall-collection-${localTime.replace(":", "")}`,
        localTime,
        pattern: cronPattern(localTime),
        timeZone: TIME_ZONE
      });
    }
  }
}
