import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  CollectionEvidenceStore,
  EvidenceStorePayloadTooLargeError,
  EvidenceStoreUnavailableError,
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
    assert.equal(await firstStore.has("run-1", `sha256:${sha256}`), true);
    assert.equal(await secondStore.has("run-1", `sha256:${sha256}`), true);
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

test("never removes a final object after another store acknowledged it", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-published-cleanup-"));
  const canonicalRoot = await realpath(root);
  try {
    const sha256 = digest(png);
    const firstStore = new CollectionEvidenceStore(canonicalRoot);
    const secondStore = new CollectionEvidenceStore(canonicalRoot);
    const originalSync = Reflect.get(firstStore, "syncDirectory").bind(firstStore) as
      (path: string) => Promise<void>;
    let enteredSync!: () => void;
    let releaseSync!: () => void;
    const syncEntered = new Promise<void>((resolve) => { enteredSync = resolve; });
    const syncReleased = new Promise<void>((resolve) => { releaseSync = resolve; });
    Reflect.set(firstStore, "syncDirectory", async (path: string) => {
      if (path === join(canonicalRoot, "run-1")) {
        enteredSync();
        await syncReleased;
        throw new Error("simulated directory fsync failure");
      }
      return originalSync(path);
    });

    const first = firstStore.put("run-1", sha256, png);
    await syncEntered;
    assert.deepEqual(await secondStore.put("run-1", sha256, Buffer.from(png)), {
      evidenceKey: `sha256:${sha256}`,
      created: false
    });
    releaseSync();
    await assert.rejects(
      () => first,
      (error) => error instanceof EvidenceStoreUnavailableError
    );

    assert.equal(await secondStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), [`${sha256}.png`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a timed run-directory swap without writing outside the evidence root", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-parent-change-"));
  const canonicalRoot = await realpath(root);
  const outside = join(dirname(canonicalRoot), `${basename(canonicalRoot)}-outside`);
  try {
    const store = new CollectionEvidenceStore(canonicalRoot);
    const original = Reflect.get(store, "requireDirectoryIdentities").bind(store) as
      (directory: unknown) => Promise<void>;
    let checks = 0;
    let enteredCheck!: () => void;
    let releaseCheck!: () => void;
    const checkEntered = new Promise<void>((resolve) => { enteredCheck = resolve; });
    const checkReleased = new Promise<void>((resolve) => { releaseCheck = resolve; });
    Reflect.set(store, "requireDirectoryIdentities", async (directory: unknown) => {
      checks += 1;
      if (checks === 3) {
        enteredCheck();
        await checkReleased;
      }
      return original(directory);
    });

    const publication = store.put("run-1", digest(png), png);
    await checkEntered;
    await rename(join(canonicalRoot, "run-1"), outside);
    await mkdir(join(canonicalRoot, "run-1"));
    releaseCheck();
    await assert.rejects(() => publication, (error) => error instanceof EvidenceStoreUnavailableError);

    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), []);
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual((await readdir(canonicalRoot)).filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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
