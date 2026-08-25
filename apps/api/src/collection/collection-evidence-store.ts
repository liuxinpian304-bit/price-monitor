import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink
} from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as productionDelay } from "node:timers/promises";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digestPattern = /^[0-9a-f]{64}$/;
const evidenceKeyPattern = /^sha256:([0-9a-f]{64})$/;
const runIdPattern = /^[A-Za-z0-9_-]+$/;
const defaultLeaseDurationMs = 5_000;
const defaultHeartbeatIntervalMs = 1_000;
const defaultLockWaitIntervalMs = 250;
const defaultReclaimClaimGraceMs = 1_000;
const maximumLeaseDurationMs = 10_000;
const maximumLeaseRecordBytes = 4_096;
const maximumLeaseReadBytes = 64 * 1024;
const localProcessInstanceId = randomUUID();

interface VerifiedDirectory {
  rootPath: string;
  rootIdentity: Stats;
  runPath: string;
  runIdentity: Stats;
}

interface VerifiedRoot {
  path: string;
  identity: Stats;
}

interface PublicationLeasePayload {
  version: 1;
  token: string;
  hostname: string;
  pid: number;
  processInstanceId: string;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

interface PublicationLeaseRecord extends PublicationLeasePayload {
  checksum: string;
}

interface PublicationLockSnapshot {
  identity: Stats;
  mtimeMs: number;
  record: PublicationLeaseRecord | null;
}

interface PublicationLock {
  handle: Awaited<ReturnType<typeof open>>;
  identity: Stats;
  path: string;
  publicationClaimPath: string;
  reclaimClaimPath: string;
  publicationClaimHeld: boolean;
  root: VerifiedRoot;
  token: string;
  refreshTail: Promise<void>;
  heartbeatError?: unknown;
}

class EvidenceStoreIdentityChangedError extends Error {}
class PublicationLockOwnershipLostError extends EvidenceStoreIdentityChangedError {}

export interface CollectionEvidenceStoreOptions {
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  heartbeatDelay?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean | undefined;
  hostname?: string;
  pid?: number;
  processInstanceId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  waitIntervalMs?: number;
  reclaimClaimGraceMs?: number;
}

export class EvidenceStoreValidationError extends Error {
  constructor() {
    super("Invalid collection evidence");
    this.name = "EvidenceStoreValidationError";
  }
}

export class EvidenceStorePayloadTooLargeError extends Error {
  constructor() {
    super("Collection evidence exceeds the size limit");
    this.name = "EvidenceStorePayloadTooLargeError";
  }
}

export class EvidenceStoreUnavailableError extends Error {
  constructor() {
    super("Collection evidence storage failed");
    this.name = "EvidenceStoreUnavailableError";
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function defaultProcessLiveness(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    return undefined;
  }
}

function isNonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function leaseChecksum(payload: PublicationLeasePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function serializeLeaseRecord(payload: PublicationLeasePayload): Buffer {
  const bytes = Buffer.from(JSON.stringify({ ...payload, checksum: leaseChecksum(payload) }) + "\n");
  if (bytes.byteLength > maximumLeaseRecordBytes) throw new EvidenceStoreUnavailableError();
  return bytes;
}

function parseLeaseRecord(line: string): PublicationLeaseRecord | null {
  if (Buffer.byteLength(line) > maximumLeaseRecordBytes) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof candidate !== "object" || candidate === null) return null;
  const version = Reflect.get(candidate, "version");
  const token = Reflect.get(candidate, "token");
  const hostname = Reflect.get(candidate, "hostname");
  const pid = Reflect.get(candidate, "pid");
  const processInstanceId = Reflect.get(candidate, "processInstanceId");
  const heartbeatAtMs = Reflect.get(candidate, "heartbeatAtMs");
  const expiresAtMs = Reflect.get(candidate, "expiresAtMs");
  const checksum = Reflect.get(candidate, "checksum");
  if (
    version !== 1
    || !isNonEmptyBoundedString(token, 128)
    || !isNonEmptyBoundedString(hostname, 255)
    || !isPositiveSafeInteger(pid)
    || !isNonEmptyBoundedString(processInstanceId, 128)
    || !isPositiveSafeInteger(heartbeatAtMs)
    || !isPositiveSafeInteger(expiresAtMs)
    || expiresAtMs <= heartbeatAtMs
    || expiresAtMs - heartbeatAtMs > maximumLeaseDurationMs
    || typeof checksum !== "string"
  ) {
    return null;
  }
  const payload: PublicationLeasePayload = {
    version,
    token,
    hostname,
    pid,
    processInstanceId,
    heartbeatAtMs,
    expiresAtMs
  };
  if (checksum !== leaseChecksum(payload)) return null;
  return { ...payload, checksum };
}

function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId) || runId === "." || runId === "..") {
    throw new EvidenceStoreValidationError();
  }
}

function assertDigest(sha256: string): void {
  if (!digestPattern.test(sha256)) throw new EvidenceStoreValidationError();
}

function digestFromKey(evidenceKey: string): string {
  const match = evidenceKeyPattern.exec(evidenceKey);
  if (!match?.[1]) throw new EvidenceStoreValidationError();
  return match[1];
}

function assertContained(parent: string, child: string): void {
  if (child !== parent && !child.startsWith(`${parent}${sep}`)) {
    throw new EvidenceStoreValidationError();
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function verifyBytes(bytes: Uint8Array, sha256: string): Buffer {
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new EvidenceStorePayloadTooLargeError();
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < pngSignature.byteLength || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new EvidenceStoreValidationError();
  }
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== sha256) throw new EvidenceStoreValidationError();
  return buffer;
}

function publicationObjectId(runId: string, sha256: string): string {
  return createHash("sha256").update(runId).update("\0").update(sha256).digest("hex");
}

export class CollectionEvidenceStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly heartbeatWait: (milliseconds: number) => Promise<void>;
  private readonly isProcessAlive: (pid: number) => boolean | undefined;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly processInstanceId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly waitIntervalMs: number;
  private readonly reclaimClaimGraceMs: number;
  private readonly writeTails = new Map<string, Promise<void>>();
  // Node has no directory-handle-relative link API; the canonical root's parent is the trust boundary.
  private rootInitialization: Promise<VerifiedRoot> | null = null;

  constructor(root: string, options: CollectionEvidenceStoreOptions = {}) {
    if (!isAbsolute(root)) throw new EvidenceStoreValidationError();
    this.root = resolve(root);
    this.now = options.now ?? Date.now;
    this.wait = options.delay ?? ((milliseconds) => productionDelay(milliseconds));
    this.heartbeatWait = options.heartbeatDelay
      ?? options.delay
      ?? ((milliseconds) => productionDelay(milliseconds, undefined, { ref: false }));
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
    this.hostname = options.hostname ?? systemHostname();
    this.pid = options.pid ?? process.pid;
    this.processInstanceId = options.processInstanceId ?? localProcessInstanceId;
    this.leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
    this.waitIntervalMs = options.waitIntervalMs ?? defaultLockWaitIntervalMs;
    this.reclaimClaimGraceMs = options.reclaimClaimGraceMs ?? defaultReclaimClaimGraceMs;

    if (
      !isNonEmptyBoundedString(this.hostname, 255)
      || !isPositiveSafeInteger(this.pid)
      || !isNonEmptyBoundedString(this.processInstanceId, 128)
      || !isPositiveSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs > maximumLeaseDurationMs
      || !isPositiveSafeInteger(this.heartbeatIntervalMs)
      || this.heartbeatIntervalMs >= this.leaseDurationMs
      || !isPositiveSafeInteger(this.waitIntervalMs)
      || !isPositiveSafeInteger(this.reclaimClaimGraceMs)
    ) {
      throw new EvidenceStoreValidationError();
    }
  }

  async initialize(): Promise<void> {
    await this.ensureCanonicalRoot();
  }

  async put(
    runId: string,
    sha256: string,
    input: Uint8Array
  ): Promise<{ evidenceKey: string; created: boolean }> {
    assertRunId(runId);
    assertDigest(sha256);
    const bytes = verifyBytes(input, sha256);

    return this.serialize(`${runId}:${sha256}`, async () => {
      try {
        const directory = await this.ensureRunDirectory(runId);
        const target = join(directory.runPath, `${sha256}.png`);
        assertContained(directory.runPath, target);
        const objectId = publicationObjectId(runId, sha256);
        const publicationLock = await this.acquirePublicationLock({
          path: directory.rootPath,
          identity: directory.rootIdentity
        }, objectId);
        const stopHeartbeat = this.startPublicationLockHeartbeat(publicationLock);
        let operationError: unknown;
        try {
          const created = await this.putWithPublicationLock(
            directory,
            target,
            sha256,
            objectId,
            bytes,
            publicationLock
          );
          return { evidenceKey: `sha256:${sha256}`, created };
        } catch (error) {
          operationError = error;
          throw error;
        } finally {
          let heartbeatError: unknown;
          try {
            await stopHeartbeat();
          } catch (error) {
            heartbeatError = error;
          }
          let releaseError: unknown;
          try {
            await this.releasePublicationLock(publicationLock);
          } catch (error) {
            releaseError = error;
          }
          if (!operationError && heartbeatError) throw heartbeatError;
          if (!operationError && releaseError) throw releaseError;
        }
      } catch (error) {
        if (
          error instanceof EvidenceStoreValidationError
          || error instanceof EvidenceStorePayloadTooLargeError
        ) {
          throw error;
        }
        throw new EvidenceStoreUnavailableError();
      }
    });
  }

  async has(runId: string, evidenceKey: string): Promise<boolean> {
    assertRunId(runId);
    const sha256 = digestFromKey(evidenceKey);
    try {
      const directory = await this.existingRunDirectory(runId);
      if (!directory) return false;
      const target = join(directory.runPath, `${sha256}.png`);
      assertContained(directory.runPath, target);
      return Boolean(await this.readVerifiedFile(directory, target, sha256));
    } catch (error) {
      if (error instanceof EvidenceStoreValidationError) return false;
      if (error instanceof EvidenceStorePayloadTooLargeError) return false;
      throw new EvidenceStoreUnavailableError();
    }
  }

  async read(runId: string, sha256: string): Promise<Buffer | null> {
    assertRunId(runId);
    assertDigest(sha256);
    try {
      const directory = await this.existingRunDirectory(runId);
      if (!directory) return null;
      const target = join(directory.runPath, `${sha256}.png`);
      assertContained(directory.runPath, target);
      return await this.readVerifiedFile(directory, target, sha256);
    } catch (error) {
      if (
        error instanceof EvidenceStoreValidationError
        || error instanceof EvidenceStorePayloadTooLargeError
      ) {
        throw error;
      }
      throw new EvidenceStoreUnavailableError();
    }
  }

  private async putWithPublicationLock(
    directory: VerifiedDirectory,
    target: string,
    sha256: string,
    objectId: string,
    bytes: Buffer,
    publicationLock: PublicationLock
  ): Promise<boolean> {
    await this.requirePublicationLockOwnership(publicationLock);
    await this.requireDirectoryIdentities(directory);
    if (await this.isVerifiedFile(directory, target, sha256)) {
      await this.acquirePublicationClaim(publicationLock);
      await this.requirePublicationLockOwnership(publicationLock);
      await this.requireDirectoryIdentities(directory);
      if (!await this.isVerifiedFile(directory, target, sha256)) {
        throw new EvidenceStoreIdentityChangedError();
      }
      await this.syncDirectory(directory.runPath);
      await this.requireDirectoryIdentities(directory);
      await this.refreshPublicationLock(publicationLock);
      await this.requirePublicationLockOwnership(publicationLock);
      return false;
    }

    const temporary = join(directory.rootPath, `.evidence.${objectId}.${randomUUID()}.tmp`);
    assertContained(directory.rootPath, temporary);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: Stats | undefined;
    let published = false;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
        0o600
      );
      temporaryIdentity = await handle.stat();
      await handle.writeFile(bytes);
      await handle.sync();
      const writtenIdentity = await handle.stat();
      if (!writtenIdentity.isFile() || writtenIdentity.size !== bytes.byteLength
        || !sameIdentity(writtenIdentity, temporaryIdentity)) {
        throw new EvidenceStoreUnavailableError();
      }
      temporaryIdentity = writtenIdentity;
      await handle.close();
      handle = undefined;

      await this.requireDirectoryIdentities(directory);
      await this.requireFileIdentity(temporary, temporaryIdentity);
      await this.acquirePublicationClaim(publicationLock);
      await this.requirePublicationLockOwnership(publicationLock);
      await this.afterFinalPreLinkIdentityCheck();
      await this.requirePublicationLockOwnership(publicationLock);

      try {
        await link(temporary, target);
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        await this.requirePublicationLockOwnership(publicationLock);
        if (!await this.isVerifiedFile(directory, target, sha256)) {
          throw new EvidenceStoreValidationError();
        }
        await this.syncDirectory(directory.runPath);
        await this.requireDirectoryIdentities(directory);
        await this.refreshPublicationLock(publicationLock);
        await this.requirePublicationLockOwnership(publicationLock);
        return false;
      }
      published = true;

      await this.requirePublicationLockOwnership(publicationLock);
      await this.requireDirectoryIdentities(directory);
      await this.requireFileIdentity(target, temporaryIdentity);
      await this.syncDirectory(directory.runPath);
      await this.requireDirectoryIdentities(directory);
      await this.requireFileIdentity(target, temporaryIdentity);
      await this.requireFileIdentity(temporary, temporaryIdentity);
      if (!await this.unlinkMatchingFileWhileClaimed(
        temporary,
        temporaryIdentity,
        publicationLock
      )) {
        throw new EvidenceStoreIdentityChangedError();
      }
      await this.syncDirectory(directory.rootPath);
      await this.requireDirectoryIdentities(directory);
      await this.requireFileIdentity(target, temporaryIdentity);
      await this.refreshPublicationLock(publicationLock);
      await this.requirePublicationLockOwnership(publicationLock);
      return true;
    } catch (error) {
      let failure = error;
      if (
        published
        && temporaryIdentity
        && error instanceof EvidenceStoreIdentityChangedError
        && !(error instanceof PublicationLockOwnershipLostError)
      ) {
        try {
          await this.rollbackPublishedLink(target, temporaryIdentity, publicationLock);
        } catch (rollbackError) {
          failure = rollbackError;
        }
      }
      throw failure;
    } finally {
      await handle?.close().catch(() => undefined);
      await this.unlinkTemporary(temporary, temporaryIdentity);
    }
  }

  private async acquirePublicationClaim(lock: PublicationLock): Promise<void> {
    if (lock.publicationClaimHeld) {
      await this.requirePublicationLockOwnership(lock);
      return;
    }

    const acquisition = lock.refreshTail.then(async () => {
      if (lock.heartbeatError) throw lock.heartbeatError;
      await this.requirePublicationLockOwnershipNow(lock);
      let linked = false;
      try {
        await link(lock.path, lock.publicationClaimPath);
        linked = true;
        const claimIdentity = await lstat(lock.publicationClaimPath);
        if (
          !claimIdentity.isFile()
          || claimIdentity.isSymbolicLink()
          || !sameIdentity(claimIdentity, lock.identity)
        ) {
          throw new PublicationLockOwnershipLostError();
        }
        lock.publicationClaimHeld = true;
        await this.syncDirectory(lock.root.path);
        await this.requirePublicationLockOwnershipNow(lock);
      } catch (error) {
        lock.publicationClaimHeld = false;
        if (linked) {
          await this.unlinkMatchingFile(lock.publicationClaimPath, lock.identity)
            .catch(() => undefined);
          await this.syncDirectory(lock.root.path).catch(() => undefined);
        }
        if (isAlreadyPresent(error) || isMissing(error)) {
          throw new PublicationLockOwnershipLostError();
        }
        throw error;
      }
    });
    lock.refreshTail = acquisition.then(
      () => undefined,
      () => undefined
    );
    return acquisition;
  }

  private async acquirePublicationLock(
    root: VerifiedRoot,
    objectId: string
  ): Promise<PublicationLock> {
    const path = join(root.path, `.evidence.${objectId}.lock`);
    const publicationClaimPath = join(root.path, `.evidence.${objectId}.lock.publish`);
    const reclaimClaimPath = join(root.path, `.evidence.${objectId}.lock.reclaim`);
    assertContained(root.path, path);
    assertContained(root.path, publicationClaimPath);
    assertContained(root.path, reclaimClaimPath);

    while (true) {
      await this.requireDirectoryIdentity(root.path, root.identity);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          path,
          constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
            | constants.O_WRONLY | noFollowFlag(),
          0o600
        );
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        let snapshot: PublicationLockSnapshot | null;
        try {
          snapshot = await this.readPublicationLock(path);
        } catch (readError) {
          if (!(readError instanceof EvidenceStoreIdentityChangedError)) throw readError;
          await this.wait(this.waitIntervalMs);
          continue;
        }
        if (!snapshot) continue;
        const publicationClaim = await this.readPublicationClaim(publicationClaimPath);
        if (publicationClaim && !sameIdentity(publicationClaim, snapshot.identity)) {
          await this.clearAbandonedPublicationClaim(root, publicationClaimPath, publicationClaim);
          await this.wait(this.waitIntervalMs);
          continue;
        }
        const stale = publicationClaim
          ? this.isPublicationClaimStale(snapshot)
          : this.isPublicationLockStale(snapshot);
        if (stale && await this.reclaimPublicationLock(
          root,
          path,
          publicationClaimPath,
          reclaimClaimPath,
          snapshot,
          publicationClaim
        )) {
          continue;
        }
        await this.wait(publicationClaim
          ? this.publicationClaimWait(snapshot)
          : this.publicationLockWait(snapshot));
        continue;
      }

      let identity: Stats | undefined;
      let blockingPublicationClaim: Stats | null = null;
      let blockingReclaimClaim: Stats | null = null;
      const token = randomUUID();
      const lock: PublicationLock = {
        handle,
        identity: undefined as unknown as Stats,
        path,
        publicationClaimPath,
        reclaimClaimPath,
        publicationClaimHeld: false,
        root,
        token,
        refreshTail: Promise.resolve()
      };
      try {
        identity = await handle.stat();
        if (!identity.isFile() || identity.isSymbolicLink()) {
          throw new EvidenceStoreIdentityChangedError();
        }
        lock.identity = identity;
        blockingPublicationClaim = await this.readPublicationClaim(publicationClaimPath);
        blockingReclaimClaim = await this.readPublicationClaim(reclaimClaimPath);
        if (blockingPublicationClaim || blockingReclaimClaim) {
          throw new EvidenceStoreIdentityChangedError();
        }
        await this.appendPublicationLeaseRecord(lock);
        await handle.sync();
        await this.syncDirectory(root.path);
        await this.requireDirectoryIdentity(root.path, root.identity);
        await this.requirePublicationLockOwnershipNow(lock);
        return lock;
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (identity) {
          if (blockingPublicationClaim || blockingReclaimClaim) {
            await this.unlinkMatchingFile(path, identity).catch(() => undefined);
            await this.syncDirectory(root.path).catch(() => undefined);
          } else {
            await this.removePublicationLockByIdentity(
              root,
              path,
              publicationClaimPath,
              reclaimClaimPath,
              identity
            ).catch(() => undefined);
          }
        }
        if (blockingPublicationClaim || blockingReclaimClaim) {
          if (blockingPublicationClaim) {
            await this.clearAbandonedPublicationClaim(
              root,
              publicationClaimPath,
              blockingPublicationClaim
            );
          }
          if (blockingReclaimClaim) {
            await this.clearAbandonedPublicationClaim(
              root,
              reclaimClaimPath,
              blockingReclaimClaim
            );
          }
          await this.wait(this.waitIntervalMs);
          continue;
        }
        throw error;
      }
    }
  }

  private async releasePublicationLock(lock: PublicationLock): Promise<void> {
    let closeError: unknown;
    let releaseError: unknown;
    try {
      await this.removeOwnedPublicationLock(lock);
    } catch (error) {
      releaseError = error;
    }
    try {
      await lock.handle.close();
    } catch (error) {
      closeError = error;
    }
    if (releaseError) throw releaseError;
    if (closeError) throw closeError;
  }

  private startPublicationLockHeartbeat(lock: PublicationLock): () => Promise<void> {
    let stop!: () => void;
    const stopped = new Promise<void>((resolveStopped) => {
      stop = resolveStopped;
    });
    const heartbeat = (async () => {
      while (true) {
        let shouldRefresh: boolean;
        try {
          shouldRefresh = await Promise.race([
            this.heartbeatWait(this.heartbeatIntervalMs).then(() => true),
            stopped.then(() => false)
          ]);
        } catch (error) {
          lock.heartbeatError ??= error;
          return;
        }
        if (!shouldRefresh) return;
        try {
          await this.refreshPublicationLock(lock);
        } catch (error) {
          lock.heartbeatError ??= error;
          return;
        }
      }
    })();

    return async () => {
      stop();
      await heartbeat;
      await lock.refreshTail;
    };
  }

  private async refreshPublicationLock(lock: PublicationLock): Promise<void> {
    if (lock.heartbeatError) throw lock.heartbeatError;
    const refresh = lock.refreshTail.then(async () => {
      if (lock.heartbeatError) throw lock.heartbeatError;
      await this.requirePublicationLockOwnershipNow(lock);
      await this.appendPublicationLeaseRecord(lock);
      await lock.handle.sync();
      await this.requirePublicationLockOwnershipNow(lock);
    });
    lock.refreshTail = refresh.then(
      () => undefined,
      (error) => {
        lock.heartbeatError ??= error;
      }
    );
    return refresh;
  }

  private async appendPublicationLeaseRecord(lock: PublicationLock): Promise<void> {
    const heartbeatAtMs = this.now();
    if (
      !isPositiveSafeInteger(heartbeatAtMs)
      || heartbeatAtMs > Number.MAX_SAFE_INTEGER - this.leaseDurationMs
    ) {
      throw new EvidenceStoreUnavailableError();
    }
    const record = serializeLeaseRecord({
      version: 1,
      token: lock.token,
      hostname: this.hostname,
      pid: this.pid,
      processInstanceId: this.processInstanceId,
      heartbeatAtMs,
      expiresAtMs: heartbeatAtMs + this.leaseDurationMs
    });
    const written = await lock.handle.write(record);
    if (written.bytesWritten !== record.byteLength) throw new EvidenceStoreUnavailableError();
  }

  private async requirePublicationLockOwnership(lock: PublicationLock): Promise<void> {
    await lock.refreshTail;
    if (lock.heartbeatError) throw lock.heartbeatError;
    await this.requirePublicationLockOwnershipNow(lock);
  }

  private async requirePublicationLockOwnershipNow(lock: PublicationLock): Promise<void> {
    await this.requireDirectoryIdentity(lock.root.path, lock.root.identity);
    const snapshot = await this.readPublicationLock(lock.path);
    if (
      !snapshot
      || !sameIdentity(snapshot.identity, lock.identity)
      || snapshot.record?.token !== lock.token
    ) {
      throw new PublicationLockOwnershipLostError();
    }
    const publicationClaim = await this.readPublicationClaim(lock.publicationClaimPath);
    if (lock.publicationClaimHeld) {
      if (!publicationClaim || !sameIdentity(publicationClaim, lock.identity)) {
        throw new PublicationLockOwnershipLostError();
      }
    } else if (publicationClaim) {
      throw new PublicationLockOwnershipLostError();
    }

    const reclaimClaim = await this.readPublicationClaim(lock.reclaimClaimPath);
    if (reclaimClaim && sameIdentity(reclaimClaim, lock.identity)) {
      throw new PublicationLockOwnershipLostError();
    }
  }

  private async readPublicationClaim(path: string): Promise<Stats | null> {
    let identity: Stats;
    try {
      identity = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new EvidenceStoreIdentityChangedError();
    }
    return identity;
  }

  private async readPublicationLock(path: string): Promise<PublicationLockSnapshot | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let expected: Stats;
      try {
        expected = await lstat(path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (!expected.isFile() || expected.isSymbolicLink()) {
        throw new EvidenceStoreIdentityChangedError();
      }

      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        try {
          handle = await open(path, constants.O_RDONLY | noFollowFlag());
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
        const opened = await handle.stat();
        if (!opened.isFile() || !sameIdentity(opened, expected)) {
          throw new EvidenceStoreIdentityChangedError();
        }
        const readLength = Math.min(opened.size, maximumLeaseReadBytes);
        const offset = opened.size - readLength;
        const bytes = Buffer.alloc(readLength);
        const result = readLength === 0
          ? { bytesRead: 0 }
          : await handle.read(bytes, 0, readLength, offset);
        const afterRead = await handle.stat();
        let pathAfterRead: Stats;
        try {
          pathAfterRead = await lstat(path);
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
        if (
          !sameIdentity(opened, afterRead)
          || !sameIdentity(opened, pathAfterRead)
          || opened.size !== afterRead.size
          || result.bytesRead !== readLength
          || pathAfterRead.isSymbolicLink()
          || !pathAfterRead.isFile()
        ) {
          continue;
        }

        let contents = bytes.toString("utf8");
        if (offset > 0) {
          const firstNewline = contents.indexOf("\n");
          contents = firstNewline < 0 ? "" : contents.slice(firstNewline + 1);
        }
        const finalNewline = contents.lastIndexOf("\n");
        const completeLines = finalNewline < 0 ? [] : contents.slice(0, finalNewline).split("\n");
        let record: PublicationLeaseRecord | null = null;
        for (let index = completeLines.length - 1; index >= 0; index -= 1) {
          record = parseLeaseRecord(completeLines[index]!);
          if (record) break;
        }
        return { identity: opened, mtimeMs: afterRead.mtimeMs, record };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    throw new EvidenceStoreIdentityChangedError();
  }

  private isPublicationLockStale(snapshot: PublicationLockSnapshot): boolean {
    if (this.publicationOwnerLiveness(snapshot) === false) return true;
    return this.isPublicationLockExpired(snapshot);
  }

  private isPublicationClaimStale(snapshot: PublicationLockSnapshot): boolean {
    const liveness = this.publicationOwnerLiveness(snapshot);
    if (liveness === true) return false;
    if (liveness === false) return true;
    return this.isPublicationLockExpired(snapshot);
  }

  private publicationOwnerLiveness(snapshot: PublicationLockSnapshot): boolean | undefined {
    const record = snapshot.record;
    if (!record || record.hostname !== this.hostname) return undefined;
    if (record.pid === this.pid) {
      return record.processInstanceId === this.processInstanceId;
    }
    try {
      return this.isProcessAlive(record.pid);
    } catch {
      return undefined;
    }
  }

  private isPublicationLockExpired(snapshot: PublicationLockSnapshot): boolean {
    const expiresAtMs = snapshot.record?.expiresAtMs
      ?? snapshot.mtimeMs + this.leaseDurationMs;
    return this.now() >= expiresAtMs;
  }

  private publicationLockWait(snapshot: PublicationLockSnapshot): number {
    const expiresAtMs = snapshot.record?.expiresAtMs
      ?? snapshot.mtimeMs + this.leaseDurationMs;
    const untilExpiry = Math.max(1, expiresAtMs - this.now());
    return Math.min(this.waitIntervalMs, untilExpiry);
  }

  private publicationClaimWait(snapshot: PublicationLockSnapshot): number {
    return this.publicationOwnerLiveness(snapshot) === true
      ? this.waitIntervalMs
      : this.publicationLockWait(snapshot);
  }

  private async reclaimPublicationLock(
    root: VerifiedRoot,
    path: string,
    publicationClaimPath: string,
    reclaimClaimPath: string,
    observed: PublicationLockSnapshot,
    observedPublicationClaim: Stats | null
  ): Promise<boolean> {
    try {
      await link(path, reclaimClaimPath);
    } catch (error) {
      if (isMissing(error)) return true;
      if (!isAlreadyPresent(error)) throw error;
      await this.clearAbandonedPublicationClaim(root, reclaimClaimPath);
      return false;
    }

    let reclaimClaimIdentity: Stats | undefined;
    try {
      reclaimClaimIdentity = await lstat(reclaimClaimPath);
      if (!sameIdentity(reclaimClaimIdentity, observed.identity)) return false;
      const latest = await this.readPublicationLock(path);
      const latestPublicationClaim = await this.readPublicationClaim(publicationClaimPath);
      if (
        !latest
        || !sameIdentity(latest.identity, observed.identity)
        || (observed.record !== null && latest.record?.token !== observed.record.token)
        || (observed.record === null && latest.record !== null)
        || !this.samePublicationClaim(
          observedPublicationClaim,
          latestPublicationClaim,
          latest.identity
        )
        || !(latestPublicationClaim
          ? this.isPublicationClaimStale(latest)
          : this.isPublicationLockStale(latest))
      ) {
        return false;
      }

      await this.requireDirectoryIdentity(root.path, root.identity);
      await this.requireFileIdentity(reclaimClaimPath, reclaimClaimIdentity);
      const confirmed = await this.readPublicationLock(path);
      const confirmedPublicationClaim = await this.readPublicationClaim(publicationClaimPath);
      if (
        !confirmed
        || !sameIdentity(confirmed.identity, reclaimClaimIdentity)
        || confirmed.record?.token !== latest.record?.token
        || !this.samePublicationClaim(
          latestPublicationClaim,
          confirmedPublicationClaim,
          confirmed.identity
        )
        || !(confirmedPublicationClaim
          ? this.isPublicationClaimStale(confirmed)
          : this.isPublicationLockStale(confirmed))
      ) {
        return false;
      }

      if (confirmedPublicationClaim) {
        await this.requireFileIdentity(publicationClaimPath, confirmedPublicationClaim);
        await this.requireFileIdentity(reclaimClaimPath, reclaimClaimIdentity);
        if (!await this.unlinkMatchingFile(publicationClaimPath, confirmedPublicationClaim)) {
          return false;
        }
        await this.syncDirectory(root.path);
      }

      await this.requireFileIdentity(reclaimClaimPath, reclaimClaimIdentity);
      const current = await this.readPublicationLock(path);
      if (
        !current
        || !sameIdentity(current.identity, reclaimClaimIdentity)
        || current.record?.token !== confirmed.record?.token
        || await this.readPublicationClaim(publicationClaimPath)
      ) {
        return false;
      }
      if (!await this.unlinkMatchingFile(path, reclaimClaimIdentity)) return false;
      await this.syncDirectory(root.path);
      return true;
    } finally {
      if (reclaimClaimIdentity) {
        await this.unlinkMatchingFile(reclaimClaimPath, reclaimClaimIdentity)
          .catch(() => undefined);
        await this.syncDirectory(root.path).catch(() => undefined);
      }
    }
  }

  private samePublicationClaim(
    observed: Stats | null,
    current: Stats | null,
    lockIdentity: Stats
  ): boolean {
    if (!observed || !current) return observed === current;
    return sameIdentity(observed, current) && sameIdentity(current, lockIdentity);
  }

  private async clearAbandonedPublicationClaim(
    root: VerifiedRoot,
    claimPath: string,
    observed?: Stats
  ): Promise<void> {
    let claimIdentity: Stats;
    try {
      claimIdentity = await lstat(claimPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!claimIdentity.isFile() || claimIdentity.isSymbolicLink()) {
      throw new EvidenceStoreIdentityChangedError();
    }
    if (observed && !sameIdentity(claimIdentity, observed)) return;
    const staleAtMs = claimIdentity.ctimeMs + this.reclaimClaimGraceMs;
    if (this.now() < staleAtMs) {
      await this.wait(Math.min(this.waitIntervalMs, Math.max(1, staleAtMs - this.now())));
      return;
    }
    await this.requireDirectoryIdentity(root.path, root.identity);
    if (await this.unlinkMatchingFile(claimPath, claimIdentity)) {
      await this.syncDirectory(root.path);
    }
  }

  private async removeOwnedPublicationLock(lock: PublicationLock): Promise<void> {
    await lock.refreshTail;
    await this.requirePublicationLockOwnershipNow(lock);
    try {
      await link(lock.path, lock.reclaimClaimPath);
    } catch (error) {
      if (isAlreadyPresent(error) || isMissing(error)) {
        throw new PublicationLockOwnershipLostError();
      }
      throw error;
    }

    let reclaimClaimIdentity: Stats | undefined;
    try {
      reclaimClaimIdentity = await lstat(lock.reclaimClaimPath);
      if (!sameIdentity(reclaimClaimIdentity, lock.identity)) {
        throw new PublicationLockOwnershipLostError();
      }
      const current = await this.readPublicationLock(lock.path);
      if (
        !current
        || !sameIdentity(current.identity, lock.identity)
        || current.record?.token !== lock.token
      ) {
        throw new PublicationLockOwnershipLostError();
      }

      const publicationClaim = await this.readPublicationClaim(lock.publicationClaimPath);
      if (lock.publicationClaimHeld) {
        if (!publicationClaim || !sameIdentity(publicationClaim, lock.identity)) {
          throw new PublicationLockOwnershipLostError();
        }
        await this.requireFileIdentity(lock.publicationClaimPath, publicationClaim);
        await this.requireFileIdentity(lock.reclaimClaimPath, reclaimClaimIdentity);
        if (!await this.unlinkMatchingFile(lock.publicationClaimPath, publicationClaim)) {
          throw new PublicationLockOwnershipLostError();
        }
        lock.publicationClaimHeld = false;
        await this.syncDirectory(lock.root.path);
      } else if (publicationClaim) {
        throw new PublicationLockOwnershipLostError();
      }

      await this.requireFileIdentity(lock.reclaimClaimPath, reclaimClaimIdentity);
      const confirmed = await this.readPublicationLock(lock.path);
      if (
        !confirmed
        || !sameIdentity(confirmed.identity, lock.identity)
        || confirmed.record?.token !== lock.token
      ) {
        throw new PublicationLockOwnershipLostError();
      }
      if (!await this.unlinkMatchingFile(lock.path, lock.identity)) {
        throw new PublicationLockOwnershipLostError();
      }
      await this.syncDirectory(lock.root.path);
    } finally {
      if (reclaimClaimIdentity) {
        await this.unlinkMatchingFile(lock.reclaimClaimPath, reclaimClaimIdentity)
          .catch(() => undefined);
        await this.syncDirectory(lock.root.path).catch(() => undefined);
      }
    }
  }

  private async removePublicationLockByIdentity(
    root: VerifiedRoot,
    path: string,
    publicationClaimPath: string,
    reclaimClaimPath: string,
    expected: Stats
  ): Promise<void> {
    try {
      await link(path, reclaimClaimPath);
    } catch (error) {
      if (isAlreadyPresent(error) || isMissing(error)) return;
      throw error;
    }

    let reclaimClaimIdentity: Stats | undefined;
    try {
      reclaimClaimIdentity = await lstat(reclaimClaimPath);
      if (!sameIdentity(reclaimClaimIdentity, expected)) return;
      await this.requireDirectoryIdentity(root.path, root.identity);
      await this.requireFileIdentity(reclaimClaimPath, expected);
      const publicationClaim = await this.readPublicationClaim(publicationClaimPath);
      if (publicationClaim && sameIdentity(publicationClaim, expected)) {
        await this.unlinkMatchingFile(publicationClaimPath, expected);
      }
      if (await this.unlinkMatchingFile(path, expected)) {
        await this.syncDirectory(root.path);
      }
    } finally {
      if (reclaimClaimIdentity) {
        await this.unlinkMatchingFile(reclaimClaimPath, reclaimClaimIdentity)
          .catch(() => undefined);
        await this.syncDirectory(root.path).catch(() => undefined);
      }
    }
  }

  private afterFinalPreLinkIdentityCheck(): Promise<void> {
    return Promise.resolve();
  }

  private async ensureCanonicalRoot(): Promise<VerifiedRoot> {
    this.rootInitialization ??= this.initializeCanonicalRoot();
    const root = await this.rootInitialization;
    await this.requireDirectoryIdentity(root.path, root.identity);
    return root;
  }

  private async initializeCanonicalRoot(): Promise<VerifiedRoot> {
    let existingAncestor = this.root;
    while (true) {
      try {
        await lstat(existingAncestor);
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) throw new EvidenceStoreValidationError();
        existingAncestor = parent;
      }
    }
    if (await realpath(existingAncestor) !== existingAncestor) {
      throw new EvidenceStoreValidationError();
    }

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || await realpath(this.root) !== this.root) {
      throw new EvidenceStoreValidationError();
    }
    return { path: this.root, identity: metadata };
  }

  private async ensureRunDirectory(runId: string): Promise<VerifiedDirectory> {
    const root = await this.ensureCanonicalRoot();
    const runPath = join(root.path, runId);
    assertContained(root.path, runPath);
    await this.requireDirectoryIdentity(root.path, root.identity);
    await mkdir(runPath, { recursive: true, mode: 0o700 });
    const runIdentity = await lstat(runPath);
    if (!runIdentity.isDirectory() || runIdentity.isSymbolicLink()
      || await realpath(runPath) !== runPath) {
      throw new EvidenceStoreValidationError();
    }
    const directory = {
      rootPath: root.path,
      rootIdentity: root.identity,
      runPath,
      runIdentity
    };
    await this.requireDirectoryIdentities(directory);
    return directory;
  }

  private async existingRunDirectory(runId: string): Promise<VerifiedDirectory | null> {
    const root = await this.ensureCanonicalRoot();
    const runPath = join(root.path, runId);
    assertContained(root.path, runPath);
    let runIdentity: Stats;
    try {
      runIdentity = await lstat(runPath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!runIdentity.isDirectory() || runIdentity.isSymbolicLink()
      || await realpath(runPath) !== runPath) {
      throw new EvidenceStoreValidationError();
    }
    const directory = {
      rootPath: root.path,
      rootIdentity: root.identity,
      runPath,
      runIdentity
    };
    await this.requireDirectoryIdentities(directory);
    return directory;
  }

  private async requireDirectoryIdentity(path: string, expected: Stats): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || !sameIdentity(metadata, expected) || await realpath(path) !== path) {
        throw new EvidenceStoreIdentityChangedError();
      }
    } catch (error) {
      if (error instanceof EvidenceStoreIdentityChangedError) throw error;
      throw new EvidenceStoreIdentityChangedError();
    }
  }

  private async requireDirectoryIdentities(directory: VerifiedDirectory): Promise<void> {
    await this.requireDirectoryIdentity(directory.rootPath, directory.rootIdentity);
    await this.requireDirectoryIdentity(directory.runPath, directory.runIdentity);
  }

  private async requireFileIdentity(path: string, expected: Stats): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !sameIdentity(metadata, expected)) {
        throw new EvidenceStoreIdentityChangedError();
      }
    } catch (error) {
      if (error instanceof EvidenceStoreIdentityChangedError) throw error;
      throw new EvidenceStoreIdentityChangedError();
    }
  }

  private async isVerifiedFile(
    directory: VerifiedDirectory,
    target: string,
    sha256: string
  ): Promise<boolean> {
    return Boolean(await this.readVerifiedFile(directory, target, sha256));
  }

  private async readVerifiedFile(
    directory: VerifiedDirectory,
    target: string,
    sha256: string
  ): Promise<Buffer | null> {
    await this.requireDirectoryIdentities(directory);
    let expected: Stats;
    try {
      expected = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceStoreValidationError();
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | noFollowFlag());
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(opened, expected)) {
        throw new EvidenceStoreIdentityChangedError();
      }
      const bytes = await handle.readFile();
      const afterRead = await handle.stat();
      const pathAfterRead = await lstat(target);
      await this.requireDirectoryIdentities(directory);
      if (!sameIdentity(opened, afterRead) || !sameIdentity(opened, pathAfterRead)
        || pathAfterRead.isSymbolicLink() || !pathAfterRead.isFile()) {
        throw new EvidenceStoreIdentityChangedError();
      }
      return verifyBytes(bytes, sha256);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async rollbackPublishedLink(
    path: string,
    expected: Stats,
    lock?: PublicationLock
  ): Promise<boolean> {
    if (!lock?.publicationClaimHeld) return false;
    await this.requirePublicationLockOwnership(lock);
    const resolvedParent = await realpath(dirname(path));
    const resolvedPath = join(resolvedParent, basename(path));
    return this.unlinkMatchingFileWhileClaimed(resolvedPath, expected, lock);
  }

  private async unlinkMatchingFileWhileClaimed(
    path: string,
    expected: Stats,
    lock: PublicationLock
  ): Promise<boolean> {
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !sameIdentity(metadata, expected)) {
      return false;
    }

    await this.requirePublicationLockOwnership(lock);
    await unlink(path);
    try {
      const afterUnlink = await lstat(path);
      if (afterUnlink.isFile() && !afterUnlink.isSymbolicLink()
        && sameIdentity(afterUnlink, expected)) {
        throw new EvidenceStoreIdentityChangedError();
      }
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    return true;
  }

  private async unlinkMatchingFile(path: string, expected: Stats): Promise<boolean> {
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !sameIdentity(metadata, expected)) {
      return false;
    }

    await unlink(path);
    try {
      const afterUnlink = await lstat(path);
      if (afterUnlink.isFile() && !afterUnlink.isSymbolicLink()
        && sameIdentity(afterUnlink, expected)) {
        throw new EvidenceStoreIdentityChangedError();
      }
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
    return true;
  }

  private async unlinkTemporary(path: string, expected: Stats | undefined): Promise<void> {
    if (!expected) return;
    try {
      await this.unlinkMatchingFile(path, expected);
    } catch {
      // A unique temp is best-effort cleanup; a published final is never removed here.
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    this.writeTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.writeTails.get(key) === tail) this.writeTails.delete(key);
    }
  }
}
