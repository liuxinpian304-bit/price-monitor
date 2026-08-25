import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
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
  const canonicalRoot = await realpath(root);
  try {
    return await run(new CollectionEvidenceStore(canonicalRoot), canonicalRoot);
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

test("publishes once across two independent store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-multi-store-"));
  const canonicalRoot = await realpath(root);
  try {
    const bytes = Buffer.alloc(1024 * 1024, 7);
    png.copy(bytes);
    const sha256 = digest(bytes);
    const firstStore = new CollectionEvidenceStore(canonicalRoot);
    const secondStore = new CollectionEvidenceStore(canonicalRoot);
    const results = await Promise.all([
      firstStore.put("run-1", sha256, bytes),
      secondStore.put("run-1", sha256, Buffer.from(bytes))
    ]);

    assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), [`${sha256}.png`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a configured root reached through a symlinked ancestor", async () => {
  const parent = await mkdtemp(join(tmpdir(), "collection-evidence-symlink-root-"));
  try {
    const physical = join(parent, "physical");
    const linked = join(parent, "linked");
    await mkdir(physical);
    await symlink(physical, linked, "dir");
    const store = new CollectionEvidenceStore(join(linked, "evidence"));

    await assert.rejects(
      () => store.put("run-1", digest(png), png),
      (error) => error instanceof EvidenceStoreValidationError
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects run-directory replacement between validation and publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-parent-change-"));
  const canonicalRoot = await realpath(root);
  try {
    const store = new CollectionEvidenceStore(canonicalRoot);
    const original = Reflect.get(store, "ensureRunDirectory").bind(store) as (runId: string) => Promise<unknown>;
    Reflect.set(store, "ensureRunDirectory", async (runId: string) => {
      const verified = await original(runId);
      await rename(join(canonicalRoot, runId), join(canonicalRoot, `${runId}-moved`));
      await mkdir(join(canonicalRoot, runId));
      return verified;
    });

    await assert.rejects(
      () => store.put("run-1", digest(png), png),
      (error) => error instanceof EvidenceStoreValidationError
    );
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), []);
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1-moved")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
