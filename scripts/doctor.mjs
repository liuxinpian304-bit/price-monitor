import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import { checkNodeVersion, commandSpawnOptions } from "./local-env.mjs";

function checkCommand(command, args, label) {
  const result = spawnSync(command, args, commandSpawnOptions());
  const ok = result.status === 0 && !result.error;

  console.log(`${ok ? "OK" : "MISSING"} ${label}`);
  return ok;
}

const node = checkNodeVersion(process.version);
console.log(`${node.ok ? "OK" : "MISSING"} ${node.message}`);

const pnpmOk = checkCommand("pnpm", ["--version"], "pnpm");
const dockerOk = checkCommand("docker", ["--version"], "Docker");
const composeOk = checkCommand("docker", ["compose", "version"], "Docker Compose");

let envOk = true;

try {
  await access(resolve(".env"), constants.F_OK);
  console.log("OK .env exists");
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }

  envOk = false;
  console.log("MISSING .env. Run pnpm setup.");
}

if (!node.ok || !pnpmOk || !dockerOk || !composeOk || !envOk) {
  process.exitCode = 1;
}
