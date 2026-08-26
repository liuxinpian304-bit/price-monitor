import assert from "node:assert/strict";
import test from "node:test";

import { assertDemoSeedAllowed } from "./demo-seed-guard.ts";

test("demo seed rejects every normalized production environment before Prisma setup", () => {
  for (const NODE_ENV of ["production", "PRODUCTION", " production ", "PrOdUcTiOn"]) {
    assert.throws(
      () => assertDemoSeedAllowed({ NODE_ENV }),
      /生产环境禁止写入演示数据/
    );
  }
});

test("demo seed requires an explicit production opt-in but stays pure", () => {
  assert.doesNotThrow(() => assertDemoSeedAllowed({
    NODE_ENV: "production",
    ALLOW_DEMO_SEED: "true"
  }));
  assert.throws(
    () => assertDemoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "false" }),
    /生产环境禁止写入演示数据/
  );
  assert.doesNotThrow(() => assertDemoSeedAllowed({ NODE_ENV: "development" }));
});
