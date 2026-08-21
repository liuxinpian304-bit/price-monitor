import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const integrationSpecSuffix = ".integration.spec.ts";
const specSuffix = ".spec.ts";

export async function discoverApiTests(rootDir, options = {}) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
      const filePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(specSuffix) &&
        (!options.portableOnly || !entry.name.endsWith(integrationSpecSuffix))
      ) {
        files.push(filePath);
      }
    }));
  }

  await visit(resolve(rootDir));
  return files.sort();
}
