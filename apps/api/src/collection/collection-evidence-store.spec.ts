import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  CollectionEvidenceStore,
  EvidenceStorePayloadTooLargeError,
  EvidenceStoreUnavailableError,
  EvidenceStoreValidationError,
  MAX_EVIDENCE_BYTES,
  supportsDirectorySync
} from "./collection-evidence-store.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

class ManualClock {
  private value: number;
  private sleepers: Array<{ at: number; resolve: () => void }> = [];

  constructor(start: number) {
    this.value = start;
  }

  readonly now = (): number => this.value;

  readonly delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
    this.sleepers.push({ at: this.value + milliseconds, resolve });
  });

  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.value + milliseconds;
    while (true) {
      const next = this.sleepers.reduce(
        (earliest, sleeper) => Math.min(earliest, sleeper.at),
        Number.POSITIVE_INFINITY
      );
      if (next > target) break;
      this.value = next;
      const ready = this.sleepers.filter((sleeper) => sleeper.at <= this.value);
      this.sleepers = this.sleepers.filter((sleeper) => sleeper.at > this.value);
      for (const sleeper of ready) sleeper.resolve();
      await flushAsyncWork();
    }
    this.value = target;
    await flushAsyncWork();
  }
}

function leaseOptions(
  clock: ManualClock,
  pid: number,
  processInstanceId: string,
  isProcessAlive: (candidatePid: number) => boolean | undefined,
  heartbeatDelay: (milliseconds: number) => Promise<void> = clock.delay
) {
  return {
    now: clock.now,
    delay: clock.delay,
    heartbeatDelay,
    isProcessAlive,
    hostname: "evidence-test-host",
    pid,
    processInstanceId,
    leaseDurationMs: 2_000,
    heartbeatIntervalMs: 500,
    waitIntervalMs: 100,
    reclaimClaimGraceMs: 100
  };
}

function publicationArtifacts(entries: string[]): string[] {
  return entries.filter((entry) => entry.startsWith(".evidence."));
}

async function publicationLeaseLinkCount(root: string): Promise<number> {
  const lock = (await readdir(root)).find((entry) => entry.endsWith(".lock"));
  assert.ok(lock, "expected an active publication lease");
  return (await stat(join(root, lock))).nlink;
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

test("skips unsupported directory synchronization on Windows only", () => {
  assert.equal(supportsDirectorySync("win32"), false);
  assert.equal(supportsDirectorySync("darwin"), true);
  assert.equal(supportsDirectorySync("linux"), true);
});

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

test("reads only an existing verified PNG by canonical run and digest", async () => {
  await withStore(async (store, root) => {
    const sha256 = digest(png);
    await store.put("run-1", sha256, png);

    assert.deepEqual(await store.read("run-1", sha256), png);
    await writeFile(join(root, "run-1", `${sha256}.png`), Buffer.from("tampered"));
    await assert.rejects(
      () => store.read("run-1", sha256),
      (error) => error instanceof EvidenceStoreValidationError
    );
    await assert.rejects(
      () => store.read("../run-1", sha256),
      (error) => error instanceof EvidenceStoreValidationError
    );
    await assert.rejects(
      () => store.read("run-1", `sha256:${sha256}`),
      (error) => error instanceof EvidenceStoreValidationError
    );
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
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps waiting past ten seconds while a live publisher renews its lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-long-publisher-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const originalDateNow = Date.now;
  const publicationGate = deferred();
  const publicationEntered = deferred();
  let first: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let second: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    Date.now = clock.now;
    const firstStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "publisher-a", () => true)
    );
    const secondStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "publisher-b", () => true)
    );
    Reflect.set(firstStore, "afterFinalPreLinkIdentityCheck", async () => {
      publicationEntered.resolve();
      await publicationGate.promise;
    });

    const sha256 = digest(png);
    first = firstStore.put("run-1", sha256, png);
    await publicationEntered.promise;
    let secondSettled = false;
    second = secondStore.put("run-1", sha256, Buffer.from(png))
      .finally(() => { secondSettled = true; });
    void second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await clock.advanceBy(11_000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondSettled, false);

    publicationGate.resolve();
    const firstResult = await first;
    await clock.advanceBy(250);
    const secondResult = await second;
    assert.deepEqual([firstResult.created, secondResult.created].sort(), [false, true]);
    assert.equal(await firstStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    publicationGate.resolve();
    Date.now = originalDateNow;
    await Promise.allSettled([first, second].filter((value) => value !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("a live publication claim fences the checked owner past lease expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-publication-claim-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const publicationGate = deferred();
  const publicationEntered = deferred();
  const neverDelay = (): Promise<void> => new Promise(() => undefined);
  let first: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let second: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const firstStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "checked-publisher", () => true, neverDelay)
    );
    const secondStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "waiting-publisher", () => true)
    );
    Reflect.set(firstStore, "afterFinalPreLinkIdentityCheck", async () => {
      publicationEntered.resolve();
      await publicationGate.promise;
    });

    const sha256 = digest(png);
    first = firstStore.put("run-1", sha256, png);
    void first.catch(() => undefined);
    await publicationEntered.promise;

    await clock.advanceBy(2_100);
    let secondSettled = false;
    second = secondStore.put("run-1", sha256, Buffer.from(png))
      .finally(() => { secondSettled = true; });
    void second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondSettled, false);

    publicationGate.resolve();
    assert.deepEqual(await first, {
      evidenceKey: `sha256:${sha256}`,
      created: true
    });
    await clock.advanceBy(250);
    assert.deepEqual(await second, {
      evidenceKey: `sha256:${sha256}`,
      created: false
    });
    assert.equal(await firstStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    publicationGate.resolve();
    await Promise.allSettled([first, second].filter((value) => value !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaims a dead publisher lease with no final and publishes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-dead-publisher-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const oldPublisherGate = deferred();
  const oldPublisherEntered = deferred();
  const neverDelay = (): Promise<void> => new Promise(() => undefined);
  let oldPublication: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const oldStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "crashed-publisher", () => true, neverDelay)
    );
    const recoveryStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "recovery-publisher", (pid) => pid === 101 ? false : true)
    );
    Reflect.set(oldStore, "afterFinalPreLinkIdentityCheck", async () => {
      oldPublisherEntered.resolve();
      await oldPublisherGate.promise;
    });

    const sha256 = digest(png);
    oldPublication = oldStore.put("run-1", sha256, png);
    void oldPublication.catch(() => undefined);
    await oldPublisherEntered.promise;

    assert.equal(await publicationLeaseLinkCount(canonicalRoot), 2);

    assert.deepEqual(await recoveryStore.put("run-1", sha256, Buffer.from(png)), {
      evidenceKey: `sha256:${sha256}`,
      created: true
    });
    oldPublisherGate.resolve();
    await assert.rejects(
      () => oldPublication!,
      (error) => error instanceof EvidenceStoreUnavailableError
    );
    assert.equal(await recoveryStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    oldPublisherGate.resolve();
    await Promise.allSettled([oldPublication].filter((value) => value !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("acknowledges a valid final after its crashed publisher leaves the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-final-stale-lock-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const releaseGate = deferred();
  const releaseEntered = deferred();
  let first: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const firstStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "crashed-after-final", () => true)
    );
    const secondStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "idempotent-retry", (pid) => pid === 101 ? false : true)
    );
    const originalRelease = Reflect.get(firstStore, "releasePublicationLock").bind(firstStore) as
      (lock: unknown) => Promise<void>;
    Reflect.set(firstStore, "releasePublicationLock", async (lock: unknown) => {
      releaseEntered.resolve();
      await releaseGate.promise;
      await originalRelease(lock);
    });

    const sha256 = digest(png);
    first = firstStore.put("run-1", sha256, png);
    void first.catch(() => undefined);
    await releaseEntered.promise;

    assert.equal(await publicationLeaseLinkCount(canonicalRoot), 2);

    assert.deepEqual(await secondStore.put("run-1", sha256, Buffer.from(png)), {
      evidenceKey: `sha256:${sha256}`,
      created: false
    });
    releaseGate.resolve();
    await assert.rejects(
      () => first!,
      (error) => error instanceof EvidenceStoreUnavailableError
    );
    assert.equal(await secondStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    releaseGate.resolve();
    await Promise.allSettled([first].filter((value) => value !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("an inconclusive expired claimant rechecks before publishing under its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-superseded-owner-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const oldPublisherGate = deferred();
  const oldPublisherEntered = deferred();
  const recoveryGate = deferred();
  const recoveryEntered = deferred();
  const neverDelay = (): Promise<void> => new Promise(() => undefined);
  let oldPublication: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let recovery: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const oldStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "old-owner", () => true, neverDelay)
    );
    const recoveryStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "new-owner", (pid) => pid === 101 ? undefined : true)
    );
    Reflect.set(oldStore, "afterFinalPreLinkIdentityCheck", async () => {
      oldPublisherEntered.resolve();
      await oldPublisherGate.promise;
    });
    Reflect.set(recoveryStore, "afterFinalPreLinkIdentityCheck", async () => {
      recoveryEntered.resolve();
      await recoveryGate.promise;
    });

    const sha256 = digest(png);
    oldPublication = oldStore.put("run-1", sha256, png);
    void oldPublication.catch(() => undefined);
    await oldPublisherEntered.promise;
    assert.equal(await publicationLeaseLinkCount(canonicalRoot), 2);
    recovery = recoveryStore.put("run-1", sha256, Buffer.from(png));
    await clock.advanceBy(2_100);
    await recoveryEntered.promise;

    oldPublisherGate.resolve();
    await assert.rejects(
      () => oldPublication!,
      (error) => error instanceof EvidenceStoreUnavailableError
    );
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), []);

    recoveryGate.resolve();
    assert.deepEqual(await recovery, {
      evidenceKey: `sha256:${sha256}`,
      created: true
    });
    assert.equal(await recoveryStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    oldPublisherGate.resolve();
    recoveryGate.resolve();
    await Promise.allSettled(
      [oldPublication, recovery].filter((value) => value !== undefined)
    );
    await rm(root, { recursive: true, force: true });
  }
});

test("two stale-lock reclaimers hold at most one publication lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-reclaimer-race-"));
  const canonicalRoot = await realpath(root);
  const clock = new ManualClock(Date.now());
  const oldPublisherGate = deferred();
  const oldPublisherEntered = deferred();
  const contenderGate = deferred();
  const contenderEntered = deferred();
  const neverDelay = (): Promise<void> => new Promise(() => undefined);
  let oldPublication: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let first: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let second: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const alive = (pid: number): boolean => pid !== 101;
    const oldStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 101, "stale-owner", () => true, neverDelay)
    );
    const firstStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 201, "reclaimer-a", alive)
    );
    const secondStore = new CollectionEvidenceStore(
      canonicalRoot,
      leaseOptions(clock, 202, "reclaimer-b", alive)
    );
    Reflect.set(oldStore, "afterFinalPreLinkIdentityCheck", async () => {
      oldPublisherEntered.resolve();
      await oldPublisherGate.promise;
    });

    let activeLeases = 0;
    let maximumActiveLeases = 0;
    let leaseEntries = 0;
    let firstLeaseStore: "first" | "second" | undefined;
    const observeLease = (store: CollectionEvidenceStore, label: "first" | "second"): void => {
      const original = Reflect.get(store, "putWithPublicationLock").bind(store) as
        (...args: unknown[]) => Promise<boolean>;
      Reflect.set(store, "putWithPublicationLock", async (...args: unknown[]) => {
        activeLeases += 1;
        leaseEntries += 1;
        maximumActiveLeases = Math.max(maximumActiveLeases, activeLeases);
        try {
          if (!firstLeaseStore) {
            firstLeaseStore = label;
            contenderEntered.resolve();
            await contenderGate.promise;
          }
          return await original(...args);
        } finally {
          activeLeases -= 1;
        }
      });
    };
    observeLease(firstStore, "first");
    observeLease(secondStore, "second");

    const sha256 = digest(png);
    oldPublication = oldStore.put("run-1", sha256, png);
    void oldPublication.catch(() => undefined);
    await oldPublisherEntered.promise;
    assert.equal(await publicationLeaseLinkCount(canonicalRoot), 2);
    first = firstStore.put("run-1", sha256, Buffer.from(png));
    second = secondStore.put("run-1", sha256, Buffer.from(png));
    await contenderEntered.promise;
    await clock.advanceBy(1_000);

    assert.equal(leaseEntries, 1);
    assert.equal(maximumActiveLeases, 1);
    contenderGate.resolve();
    const winningResult = await (firstLeaseStore === "first" ? first : second)!;
    await clock.advanceBy(250);
    const losingResult = await (firstLeaseStore === "first" ? second : first)!;
    assert.deepEqual([winningResult.created, losingResult.created].sort(), [false, true]);
    assert.equal(maximumActiveLeases, 1);

    oldPublisherGate.resolve();
    await assert.rejects(
      () => oldPublication!,
      (error) => error instanceof EvidenceStoreUnavailableError
    );
    assert.equal(await firstStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    oldPublisherGate.resolve();
    contenderGate.resolve();
    await Promise.allSettled(
      [oldPublication, first, second].filter((value) => value !== undefined)
    );
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

test("does not expose a final object to another store until publication cleanup completes", async () => {
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
    let secondSettled = false;
    const second = secondStore.put("run-1", sha256, Buffer.from(png))
      .finally(() => { secondSettled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondSettled, false);
    } finally {
      releaseSync();
    }
    await assert.rejects(
      () => first,
      (error) => error instanceof EvidenceStoreUnavailableError
    );
    assert.deepEqual(await second, {
      evidenceKey: `sha256:${sha256}`,
      created: false
    });

    assert.equal(await secondStore.has("run-1", `sha256:${sha256}`), true);
    assert.deepEqual(await readdir(join(canonicalRoot, "run-1")), [`${sha256}.png`]);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successor waits for the prior reclaim link to leave the canonical root", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-release-reclaim-"));
  const canonicalRoot = await realpath(root);
  const releaseGate = deferred();
  const releaseEntered = deferred();
  let first: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  let second: Promise<{ evidenceKey: string; created: boolean }> | undefined;
  try {
    const firstStore = new CollectionEvidenceStore(canonicalRoot);
    const secondStore = new CollectionEvidenceStore(canonicalRoot);
    const originalUnlink = Reflect.get(firstStore, "unlinkMatchingFile").bind(firstStore) as
      (path: string, expected: Awaited<ReturnType<typeof stat>>) => Promise<boolean>;
    let paused = false;
    Reflect.set(firstStore, "unlinkMatchingFile", async (
      path: string,
      expected: Awaited<ReturnType<typeof stat>>
    ) => {
      if (!paused && path.endsWith(".lock.reclaim")) {
        const lockExists = await stat(path.slice(0, -".reclaim".length)).then(
          () => true,
          () => false
        );
        if (!lockExists) {
          paused = true;
          releaseEntered.resolve();
          await releaseGate.promise;
        }
      }
      return originalUnlink(path, expected);
    });

    const sha256 = digest(png);
    first = firstStore.put("run-1", sha256, png);
    await releaseEntered.promise;

    let secondSettled = false;
    second = secondStore.put("run-1", sha256, Buffer.from(png))
      .finally(() => { secondSettled = true; });
    void second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondSettled, false);

    releaseGate.resolve();
    assert.deepEqual(await first, {
      evidenceKey: `sha256:${sha256}`,
      created: true
    });
    assert.deepEqual(await second, {
      evidenceKey: `sha256:${sha256}`,
      created: false
    });
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    releaseGate.resolve();
    await Promise.allSettled([first, second].filter((value) => value !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

test("rolls back a check-to-link child-symlink publication outside the evidence root", async () => {
  const root = await mkdtemp(join(tmpdir(), "collection-evidence-parent-change-"));
  const canonicalRoot = await realpath(root);
  const outside = join(dirname(canonicalRoot), `${basename(canonicalRoot)}-outside`);
  const movedRun = join(canonicalRoot, "run-1-original");
  try {
    await mkdir(outside);
    const store = new CollectionEvidenceStore(canonicalRoot);
    let enteredCheck!: () => void;
    let releaseCheck!: () => void;
    const checkEntered = new Promise<void>((resolve) => { enteredCheck = resolve; });
    const checkReleased = new Promise<void>((resolve) => { releaseCheck = resolve; });
    Reflect.set(store, "afterFinalPreLinkIdentityCheck", async () => {
      enteredCheck();
      await checkReleased;
    });

    const sha256 = digest(png);
    const publication = store.put("run-1", sha256, png);
    await checkEntered;
    await rename(join(canonicalRoot, "run-1"), movedRun);
    await symlink(outside, join(canonicalRoot, "run-1"), "dir");
    releaseCheck();
    await assert.rejects(() => publication, (error) => error instanceof EvidenceStoreUnavailableError);

    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(movedRun), []);
    assert.deepEqual(publicationArtifacts(await readdir(canonicalRoot)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rollback never removes a pre-existing final with a different inode", async () => {
  await withStore(async (store, root) => {
    const sha256 = digest(png);
    await store.put("run-1", sha256, png);
    const target = join(root, "run-1", `${sha256}.png`);
    const unrelatedTemporary = join(root, ".unrelated.tmp");
    await writeFile(unrelatedTemporary, png, { mode: 0o600 });
    const unrelatedIdentity = await stat(unrelatedTemporary);
    const rollback = Reflect.get(store, "rollbackPublishedLink") as
      ((path: string, expected: Awaited<ReturnType<typeof stat>>) => Promise<boolean>) | undefined;

    assert.equal(typeof rollback, "function");
    assert.equal(await rollback!.call(store, target, unrelatedIdentity), false);
    assert.equal(await store.has("run-1", `sha256:${sha256}`), true);
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
