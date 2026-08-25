import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digestPattern = /^[0-9a-f]{64}$/;
const evidenceKeyPattern = /^sha256:([0-9a-f]{64})$/;
const runIdPattern = /^[A-Za-z0-9_-]+$/;

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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
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

  constructor(root: string) {
    if (!isAbsolute(root)) throw new EvidenceStoreValidationError();
    this.root = resolve(root);
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
        const runDirectory = await this.ensureRunDirectory(runId);
        const target = join(runDirectory, `${sha256}.png`);
        assertContained(runDirectory, target);

        if (await this.isVerifiedFile(target, sha256)) {
          return { evidenceKey: `sha256:${sha256}`, created: false };
        }

        const temporary = join(runDirectory, `.${sha256}.${randomUUID()}.tmp`);
        assertContained(runDirectory, temporary);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600
          );
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporary, target);
        } catch (error) {
          await handle?.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
          throw error;
        }

        return { evidenceKey: `sha256:${sha256}`, created: true };
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
      const runDirectory = await this.existingRunDirectory(runId);
      if (!runDirectory) return false;
      const target = join(runDirectory, `${sha256}.png`);
      assertContained(runDirectory, target);
      return await this.isVerifiedFile(target, sha256);
    } catch (error) {
      if (error instanceof EvidenceStoreValidationError) return false;
      if (error instanceof EvidenceStorePayloadTooLargeError) return false;
      throw new EvidenceStoreUnavailableError();
    }
  }

  private async ensureRunDirectory(runId: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new EvidenceStoreValidationError();
    }
    const canonicalRoot = await realpath(this.root);
    const runDirectory = join(canonicalRoot, runId);
    assertContained(canonicalRoot, runDirectory);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const runMetadata = await lstat(runDirectory);
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()) {
      throw new EvidenceStoreValidationError();
    }
    const canonicalRun = await realpath(runDirectory);
    assertContained(canonicalRoot, canonicalRun);
    if (canonicalRun !== runDirectory) throw new EvidenceStoreValidationError();
    return canonicalRun;
  }

  private async existingRunDirectory(runId: string): Promise<string | null> {
    let rootMetadata;
    try {
      rootMetadata = await lstat(this.root);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new EvidenceStoreValidationError();
    }
    const canonicalRoot = await realpath(this.root);
    const runDirectory = join(canonicalRoot, runId);
    assertContained(canonicalRoot, runDirectory);
    let runMetadata;
    try {
      runMetadata = await lstat(runDirectory);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()) {
      throw new EvidenceStoreValidationError();
    }
    const canonicalRun = await realpath(runDirectory);
    assertContained(canonicalRoot, canonicalRun);
    if (canonicalRun !== runDirectory) throw new EvidenceStoreValidationError();
    return canonicalRun;
  }

  private async isVerifiedFile(target: string, sha256: string): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceStoreValidationError();
    }
    const bytes = await readFile(target);
    verifyBytes(bytes, sha256);
    return true;
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
