import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  checkNodeVersion,
  collectorDoctorPlan,
  commandSpawnOptions,
  createLocalEnv
} from "./local-env.mjs";

test("API runtime scripts load the repository root env file with Node", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8"));

  assert.equal(
    packageJson.scripts.dev,
    "node --env-file=../../.env --import=tsx --watch src/main.ts"
  );
  assert.equal(
    packageJson.scripts.start,
    "node --env-file=../../.env --import=tsx src/main.ts"
  );
  assert.equal(
    packageJson.scripts["seed:demo"],
    "node --env-file=../../.env --import=tsx src/database/seed-demo.ts"
  );
});

test("creates a local env with a generated key and preserves all public settings", () => {
  const result = createLocalEnv(
    "API_PORT=4100\nSETTINGS_MASTER_KEY=replace-me\n",
    "a".repeat(64)
  );

  assert.equal(result, `API_PORT=4100\nSETTINGS_MASTER_KEY=${"a".repeat(64)}\n`);
});

test("requires Node 22 or newer", () => {
  assert.equal(checkNodeVersion("v22.12.0").ok, true);
  assert.equal(checkNodeVersion("v20.18.0").ok, false);
});

test("uses a shell for Windows command shims but not on other platforms", () => {
  assert.equal(commandSpawnOptions("win32").shell, true);
  assert.equal(commandSpawnOptions("darwin").shell, false);
  assert.equal(commandSpawnOptions("linux").shell, false);
});

test("adds live collector diagnostics to doctor only on macOS", () => {
  assert.deepEqual(collectorDoctorPlan("darwin"), [{
    command: "pnpm",
    args: ["collector:diagnose"],
    label: "macOS collector diagnostics"
  }]);
  assert.deepEqual(collectorDoctorPlan("win32"), []);
  assert.deepEqual(collectorDoctorPlan("linux"), []);
});
