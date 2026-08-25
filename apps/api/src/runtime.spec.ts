import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeLifecycle } from "./runtime-lifecycle.ts";

test("runtime starts one schedule worker and closes worker, queue, Redis, then Prisma", async () => {
  const events: string[] = [];
  let registered = 0;
  const runtime = createRuntimeLifecycle({
    scheduler: { registerSchedules: async () => { registered += 1; } },
    worker: { close: async () => { events.push("worker"); } },
    queue: { close: async () => { events.push("queue"); } },
    redis: { disconnect: () => { events.push("redis"); }, status: "ready" },
    prisma: { $disconnect: async () => { events.push("prisma"); } }
  });

  await runtime.start();
  await runtime.start();
  await runtime.close();

  assert.equal(registered, 1);
  assert.deepEqual(events, ["worker", "queue", "redis", "prisma"]);
});
