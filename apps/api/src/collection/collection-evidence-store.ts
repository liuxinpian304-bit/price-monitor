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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digestPattern = /^[0-9a-f]{64}$/;
const evidenceKeyPattern = /^sha256:([0-9a-f]{64})$/;
const runIdPattern = /^[A-Za-z0-9_-]+$/;

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

class EvidenceStoreIdentityChangedError extends Error {}

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

export class CollectionEvidenceStore {
  private readonly root: string;
  private readonly writeTails = new Map<string, Promise<void>>();
  // Node has no directory-handle-relative link API; the canonical root's parent is the trust boundary.
  private rootInitialization: Promise<VerifiedRoot> | null = null;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new EvidenceStoreValidationError();
    this.root = resolve(root);
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

        if (await this.isVerifiedFile(directory, target, sha256)) {
          await this.syncDirectory(directory.runPath);
          await this.requireDirectoryIdentities(directory);
          return { evidenceKey: `sha256:${sha256}`, created: false };
        }

        const temporary = join(directory.rootPath, `.${runId}.${sha256}.${randomUUID()}.tmp`);
        assertContained(directory.rootPath, temporary);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let temporaryIdentity: Stats | undefined;
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

          try {
            await link(temporary, target);
          } catch (error) {
            if (!isAlreadyPresent(error)) throw error;
            if (!await this.isVerifiedFile(directory, target, sha256)) {
              throw new EvidenceStoreValidationError();
            }
            await this.syncDirectory(directory.runPath);
            await this.requireDirectoryIdentities(directory);
            await this.requireFileIdentity(temporary, temporaryIdentity);
            await unlink(temporary);
            await this.syncDirectory(directory.rootPath);
            await this.requireDirectoryIdentities(directory);
            return { evidenceKey: `sha256:${sha256}`, created: false };
          }

          await this.requireDirectoryIdentities(directory);
          const targetMetadata = await lstat(target);
          if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()
            || !temporaryIdentity || !sameIdentity(targetMetadata, temporaryIdentity)) {
            throw new EvidenceStoreIdentityChangedError();
          }
          await this.syncDirectory(directory.runPath);
          await this.requireDirectoryIdentities(directory);
          await this.requireFileIdentity(temporary, temporaryIdentity);
          await unlink(temporary);
          await this.syncDirectory(directory.rootPath);
          await this.requireDirectoryIdentities(directory);
          return { evidenceKey: `sha256:${sha256}`, created: true };
        } catch (error) {
          await handle?.close().catch(() => undefined);
          await this.unlinkTemporary(temporary, temporaryIdentity);
          throw error;
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
      return await this.isVerifiedFile(directory, target, sha256);
    } catch (error) {
      if (error instanceof EvidenceStoreValidationError) return false;
      if (error instanceof EvidenceStorePayloadTooLargeError) return false;
      throw new EvidenceStoreUnavailableError();
    }
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
    await this.requireDirectoryIdentities(directory);
    let expected: Stats;
    try {
      expected = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return false;
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
      verifyBytes(bytes, sha256);
      return true;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async unlinkTemporary(path: string, expected: Stats | undefined): Promise<void> {
    if (!expected) return;
    try {
      const metadata = await lstat(path);
      if (metadata.isFile() && !metadata.isSymbolicLink() && sameIdentity(metadata, expected)) {
        await unlink(path);
      }
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
