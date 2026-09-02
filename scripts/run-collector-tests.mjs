import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const specSuffix = ".spec.ts";

async function discoverCollectorTests(rootDirectory) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile() && entry.name.endsWith(specSuffix)) {
        files.push(filePath);
      }
    }));
  }

  try {
    await visit(resolve(rootDirectory));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return files.sort();
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(scriptDirectory, "../apps/collector/src");
const files = await discoverCollectorTests(sourceDirectory);

if (files.length === 0) {
  console.error("No collector test files found.");
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
