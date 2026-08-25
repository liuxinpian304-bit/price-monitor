import assert from "node:assert/strict";
import test from "node:test";

import { CollectionScheduler, type CollectionSchedule } from "./collection.scheduler.ts";
import { CollectionScheduleProcessor } from "./collection.processor.ts";

class FakeScheduleQueue {
  readonly schedules: CollectionSchedule[] = [];
  readonly removed: string[] = [];
  async upsertSchedule(schedule: CollectionSchedule) { this.schedules.push(schedule); }
  async removeSchedule(id: string) { this.removed.push(id); }
}

test("scheduler registers the twelve slots only for enabled desktop collection", async () => {
  const queue = new FakeScheduleQueue();
  const desktop = new CollectionScheduler(queue, async () => ({ enabled: true, provider: "desktop" }));
  await desktop.registerSchedules();
  assert.equal(queue.schedules.length, 12);

  const disabledQueue = new FakeScheduleQueue();
  await new CollectionScheduler(disabledQueue, async () => ({ enabled: false, provider: "desktop" })).registerSchedules();
  assert.equal(disabledQueue.schedules.length, 0);
  assert.equal(disabledQueue.removed.length, 12);

  const manualQueue = new FakeScheduleQueue();
  await new CollectionScheduler(manualQueue, async () => ({ enabled: true, provider: "manual" })).registerSchedules();
  assert.equal(manualQueue.schedules.length, 0);
  assert.equal(manualQueue.removed.length, 12);
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

test("an already waiting clock job is ignored after schedule disable or provider change", async () => {
  const calls: Date[] = [];
  let settings: { enabled: boolean; provider: "manual" | "desktop" } = {
    enabled: false,
    provider: "desktop"
  };
  const processor = new CollectionScheduleProcessor(
    { enqueueEnabledModels: async (scheduledFor) => { calls.push(scheduledFor); return []; } },
    async () => settings
  );

  await processor.process({ timestamp: 1_756_086_600_000 });
  settings = { enabled: true, provider: "manual" };
  await processor.process({ timestamp: 1_756_086_600_000 });

  assert.equal(calls.length, 0);
});
