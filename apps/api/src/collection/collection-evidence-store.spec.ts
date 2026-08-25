import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CollectionEvidenceStore,
  EvidenceStorePayloadTooLargeError,
  EvidenceStoreValidationError,
  MAX_EVIDENCE_BYTES
} from "./collection-evidence-store.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withStore<T>(run: (store: CollectionEvidenceStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-"));
  try {
    return await run(new CollectionEvidenceStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writes a verified PNG atomically and does not rewrite an idempotent repeat", async () => {
  await withStore(async (store, root) => {
    const sha256 = digest(png);
    const first = await store.put("run-1", sha256, png);
    const target = join(root, "run-1", `${sha256}.png`);
    const firstStat = await stat(target);

    const second = await store.put("run-1", sha256, Buffer.from(png));
    const secondStat = await stat(target);

    assert.deepEqual(first, { evidenceKey: `sha256:${sha256}`, created: true });
    assert.deepEqual(second, { evidenceKey: `sha256:${sha256}`, created: false });
    assert.equal(secondStat.ino, firstStat.ino);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
    assert.deepEqual(await readdir(join(root, "run-1")), [`${sha256}.png`]);
    assert.equal(await store.has("run-1", `sha256:${sha256}`), true);
  });
});

test("serializes concurrent same-hash writes into one object", async () => {
  await withStore(async (store, root) => {
    const sha256 = digest(png);
    const results = await Promise.all([
      store.put("run-1", sha256, png),
      store.put("run-1", sha256, Buffer.from(png))
    ]);

    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(await readdir(join(root, "run-1")), [`${sha256}.png`]);
  });
});

test("rejects oversized, non-PNG, and hash-mismatched bytes before writing", async () => {
  await withStore(async (store, root) => {
    const oversized = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    png.copy(oversized, 0, 0, 8);

    await assert.rejects(
      () => store.put("run-1", digest(oversized), oversized),
      (error) => error instanceof EvidenceStorePayloadTooLargeError
    );
    await assert.rejects(
      () => store.put("run-1", digest(Buffer.from("not png")), Buffer.from("not png")),
      (error) => error instanceof EvidenceStoreValidationError
    );
    await assert.rejects(
      () => store.put("run-1", "0".repeat(64), png),
      (error) => error instanceof EvidenceStoreValidationError
    );
    await assert.rejects(() => readdir(join(root, "run-1")), { code: "ENOENT" });
  });
});

test("rejects traversal and every non-canonical digest spelling", async () => {
  await withStore(async (store) => {
    const sha256 = digest(png);
    for (const invalid of [
      sha256.toUpperCase(),
      `sha256:${sha256}`,
      sha256.slice(1),
      `${sha256}/x`,
      `${sha256}\\x`,
      `../${sha256}`
    ]) {
      await assert.rejects(
        () => store.put("run-1", invalid, png),
        (error) => error instanceof EvidenceStoreValidationError,
        invalid
      );
    }

    for (const runId of [".", "..", "../run-1", "run/1", "run\\1", "run%2f1"]) {
      await assert.rejects(
        () => store.put(runId, sha256, png),
        (error) => error instanceof EvidenceStoreValidationError,
        runId
      );
    }
  });
});

test("treats missing or tampered objects as absent", async () => {
  await withStore(async (store) => {
    const sha256 = digest(png);
    assert.equal(await store.has("run-1", `sha256:${sha256}`), false);
    await store.put("run-1", sha256, png);
    assert.equal(await store.has("run-1", `sha256:${"f".repeat(64)}`), false);
  });
});
