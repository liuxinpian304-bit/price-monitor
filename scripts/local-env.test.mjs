import assert from "node:assert/strict";
import test from "node:test";

import { checkNodeVersion, commandSpawnOptions, createLocalEnv } from "./local-env.mjs";

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
