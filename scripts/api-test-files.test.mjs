import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { discoverApiTests } from "./api-test-files.mjs";

test("discovers API specs portably and can exclude integration specs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "api-test-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  await mkdir(join(root, "nested"));
  await Promise.all([
    writeFile(join(root, "plain.spec.ts"), ""),
    writeFile(join(root, "db.integration.spec.ts"), ""),
    writeFile(join(root, "nested", "ignored.ts"), ""),
  ]);

  const all = await discoverApiTests(root);
  const portable = await discoverApiTests(root, { portableOnly: true });

  assert.deepEqual(all.map((file) => basename(file)), ["db.integration.spec.ts", "plain.spec.ts"]);
  assert.deepEqual(portable.map((file) => basename(file)), ["plain.spec.ts"]);
});
