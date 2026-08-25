import assert from "node:assert/strict";
import test from "node:test";

import { CollectionScheduler, type CollectionSchedule } from "./collection.scheduler.ts";
import { CollectionScheduleProcessor } from "./collection.processor.ts";

class FakeScheduleQueue {
  readonly schedules: CollectionSchedule[] = [];
  readonly removed: string[] = [];
  existing: string[] = [];
  async upsertSchedule(schedule: CollectionSchedule) { this.schedules.push(schedule); }
  async removeSchedule(id: string) { this.removed.push(id); }
  async listScheduleIds() { return this.existing; }
}

test("scheduler registers the twelve slots only for enabled desktop collection", async () => {
  const queue = new FakeScheduleQueue();
  const desktop = new CollectionScheduler(queue, async () => ({
    enabled: true,
    provider: "desktop",
    checkTimes: ["09:30", "11:45"]
  }));
  await desktop.registerSchedules();
  assert.deepEqual(queue.schedules.map((schedule) => schedule.id), [
    "tmall-collection-0930",
    "tmall-collection-1145"
  ]);

  const disabledQueue = new FakeScheduleQueue();
  disabledQueue.existing = ["tmall-collection-0930", "tmall-collection-obsolete", "other-job"];
  await new CollectionScheduler(disabledQueue, async () => ({
    enabled: false,
    provider: "desktop",
    checkTimes: ["09:30"]
  })).registerSchedules();
  assert.equal(disabledQueue.schedules.length, 0);
  assert.deepEqual(disabledQueue.removed, ["tmall-collection-0930", "tmall-collection-obsolete"]);

  const manualQueue = new FakeScheduleQueue();
  manualQueue.existing = ["tmall-collection-0930"];
  await new CollectionScheduler(manualQueue, async () => ({
    enabled: true,
    provider: "manual",
    checkTimes: ["09:30"]
  })).registerSchedules();
  assert.equal(manualQueue.schedules.length, 0);
  assert.deepEqual(manualQueue.removed, ["tmall-collection-0930"]);
});

test("scheduler removes obsolete persisted IDs while preserving unrelated schedulers", async () => {
  const queue = new FakeScheduleQueue();
  queue.existing = [
    "tmall-collection-0930",
    "tmall-collection-1030",
    "unrelated-scheduler"
  ];
  const scheduler = new CollectionScheduler(queue, async () => ({
    enabled: true,
    provider: "desktop",
    checkTimes: ["09:30", "11:45"]
  }));

  await scheduler.registerSchedules();

  assert.deepEqual(queue.removed, ["tmall-collection-1030"]);
  assert.deepEqual(queue.schedules.map((schedule) => schedule.localTime), ["09:30", "11:45"]);
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
