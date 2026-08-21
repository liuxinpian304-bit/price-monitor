import assert from "node:assert/strict";
import test from "node:test";

import { HealthService } from "./health.service.ts";

test("health reports database, redis and latest collection state", async () => {
  const service = new HealthService(
    { ping: async () => true },
    { ping: async () => true },
    { latest: async () => ({ status: "SUCCEEDED", finishedAt: new Date("2026-08-19T01:30:00Z") }) }
  );

  const result = await service.getHealth();

  assert.equal(result.status, "ok");
  assert.equal(result.database, "up");
  assert.equal(result.redis, "up");
  assert.equal(result.collection.status, "SUCCEEDED");
});

test("health becomes degraded when a dependency is unavailable", async () => {
  const service = new HealthService(
    { ping: async () => false },
    { ping: async () => true },
    { latest: async () => null }
  );

  const result = await service.getHealth();

  assert.equal(result.status, "degraded");
  assert.equal(result.database, "down");
});
