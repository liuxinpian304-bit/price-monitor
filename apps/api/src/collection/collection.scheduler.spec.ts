import assert from "node:assert/strict";
import test from "node:test";

import { CollectionScheduler, type CollectionSchedule } from "./collection.scheduler.ts";
import { CollectionScheduleProcessor } from "./collection.processor.ts";

class FakeScheduleQueue {
  readonly schedules: CollectionSchedule[] = [];
  async upsertSchedule(schedule: CollectionSchedule) { this.schedules.push(schedule); }
}

test("scheduler registers the twelve slots only for enabled desktop collection", async () => {
  const queue = new FakeScheduleQueue();
  const desktop = new CollectionScheduler(queue, async () => ({ enabled: true, provider: "desktop" }));
  await desktop.registerSchedules();
  assert.equal(queue.schedules.length, 12);

  const disabledQueue = new FakeScheduleQueue();
  await new CollectionScheduler(disabledQueue, async () => ({ enabled: false, provider: "desktop" })).registerSchedules();
  assert.equal(disabledQueue.schedules.length, 0);

  const manualQueue = new FakeScheduleQueue();
  await new CollectionScheduler(manualQueue, async () => ({ enabled: true, provider: "manual" })).registerSchedules();
  assert.equal(manualQueue.schedules.length, 0);
});

test("schedule worker only creates database runs and never calls a desktop collector", async () => {
  const calls: Date[] = [];
  const processor = new CollectionScheduleProcessor({
    enqueueEnabledModels: async (scheduledFor) => { calls.push(scheduledFor); return []; }
  });

  await processor.process({ timestamp: 1_756_086_600_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toISOString(), "2025-08-25T01:50:00.000Z");
});
