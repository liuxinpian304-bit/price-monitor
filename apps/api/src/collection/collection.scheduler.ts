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

function cronPattern(localTime: string): string {
  const [hour, minute] = localTime.split(":");
  return `0 ${Number(minute)} ${Number(hour)} * * *`;
}

export class CollectionScheduler {
  private readonly queue: CollectionScheduleQueue;

  constructor(queue: CollectionScheduleQueue) {
    this.queue = queue;
  }

  async registerSchedules(): Promise<void> {
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
