import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  BullMqCollectionScheduleQueue,
  RedisCollectionLock,
  type ScheduledCollectionJob
} from "./collection.processor.ts";
import { CollectionScheduler } from "./collection.scheduler.ts";
import { CHECK_TIMES } from "../../../../packages/config/src/schedule.ts";

const redis = new Redis({ host: "127.0.0.1", port: 6380, maxRetriesPerRequest: null });
const queue = new Queue<ScheduledCollectionJob>("tmall-price-monitor-schedule-test", {
  connection: redis
});

before(async () => {
  await queue.obliterate({ force: true });
});

after(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  if (redis.status !== "end") {
    redis.disconnect();
  }
});

test("registers twelve BullMQ job schedulers with Shanghai timezone", async () => {
  await new CollectionScheduler(new BullMqCollectionScheduleQueue(queue)).registerSchedules();

  const schedulers = await queue.getJobSchedulers(0, -1, true);
  assert.equal(schedulers.length, 12);
  assert.ok(schedulers.every((scheduler) => scheduler.tz === "Asia/Shanghai"));
  assert.ok(schedulers.some((scheduler) => scheduler.pattern === "0 30 3 * * *"));
  assert.ok(schedulers.some((scheduler) => scheduler.pattern === "0 30 22 * * *"));
});

test("reconcile removes all persisted desktop schedulers after disable or provider change", async () => {
  const adapter = new BullMqCollectionScheduleQueue(queue);
  let settings: { enabled: boolean; provider: "desktop" | "manual"; checkTimes: string[] } = {
    enabled: true,
    provider: "desktop",
    checkTimes: [...CHECK_TIMES]
  };
  const scheduler = new CollectionScheduler(adapter, async () => settings);
  await scheduler.registerSchedules();
  assert.equal((await queue.getJobSchedulers(0, -1, true)).length, 12);

  settings = { enabled: true, provider: "desktop", checkTimes: ["09:30", "11:45"] };
  await scheduler.registerSchedules();
  assert.deepEqual(
    (await queue.getJobSchedulers(0, -1, true)).map((entry) => entry.key).sort(),
    ["tmall-collection-0930", "tmall-collection-1145"]
  );

  settings = { enabled: false, provider: "desktop", checkTimes: ["09:30"] };
  await scheduler.registerSchedules();
  assert.equal((await queue.getJobSchedulers(0, -1, true)).length, 0);

  settings = { enabled: true, provider: "desktop", checkTimes: [...CHECK_TIMES] };
  await scheduler.registerSchedules();
  settings = { enabled: true, provider: "manual", checkTimes: [...CHECK_TIMES] };
  await scheduler.registerSchedules();
  assert.equal((await queue.getJobSchedulers(0, -1, true)).length, 0);
});

test("only releases a Redis lock when the owner token matches", async () => {
  const lock = new RedisCollectionLock(redis);
  const key = "test:collection:model:model-1";
  await redis.del(key);

  const first = await lock.acquire(key, 30_000);
  const second = await lock.acquire(key, 30_000);
  assert.ok(first);
  assert.equal(second, null);

  await lock.release(key, "wrong-token");
  assert.equal(await lock.acquire(key, 30_000), null);
  await lock.release(key, first!);
  assert.ok(await lock.acquire(key, 30_000));
  await redis.del(key);
});
