import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { discoverApiTests } from "./api-test-files.mjs";

const portableOnly = process.argv.includes("--portable");
const files = await discoverApiTests(resolve("apps/api/src"), { portableOnly });

if (files.length === 0) {
  console.error("No API test files found.");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    { stdio: "inherit" }
  );

  if (result.status !== 0) {
    process.exitCode = 1;
  }
}
