import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface EvidenceUploadApi {
  uploadEvidence(
    runId: string,
    evidenceKey: string,
    bytes: Uint8Array
  ): Promise<{ evidenceKey: string }>;
}

export interface EvidenceFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

export interface EvidenceUploaderOptions {
  fileSystem?: EvidenceFileSystem;
}

export type EvidenceUploadErrorCode =
  | "INVALID_RUN_ID"
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "READ_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PNG"
  | "HASH_MISMATCH"
  | "ACKNOWLEDGEMENT_MISMATCH";

export class EvidenceUploadError extends Error {
  readonly code: EvidenceUploadErrorCode;
  readonly transient = false;

  constructor(code: EvidenceUploadErrorCode) {
    super(`Evidence upload failed: ${code}`);
    this.name = "EvidenceUploadError";
    this.code = code;
  }
}

const EVIDENCE_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const defaultFileSystem: EvidenceFileSystem = { realpath, lstat, open };

function isStrictDescendant(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directChildPath(runDirectory: string, manifestPath: string): string {
  if (manifestPath.length === 0 || manifestPath.includes("\0")) {
    throw new EvidenceUploadError("INVALID_PATH");
  }
  const absolute = isAbsolute(manifestPath);
  if (!absolute && manifestPath.includes("/")) {
    throw new EvidenceUploadError("INVALID_PATH");
  }
  const candidate = absolute
    ? manifestPath
    : join(runDirectory, manifestPath);
  const filename = basename(candidate);
  if (filename.length === 0 || filename === "." || filename === ".."
    || filename.includes("/") || filename.includes("\\") || filename.includes("%")
    || manifestPath.includes("\\") || !filename.toLowerCase().endsWith(".png")
    || dirname(candidate) !== runDirectory
    || candidate !== join(runDirectory, filename)) {
    throw new EvidenceUploadError("INVALID_PATH");
  }
  return candidate;
}

function validateManifest(
  manifest: Record<string, string>,
  runDirectory: string
): Array<[string, string]> {
  return Object.entries(manifest).map(([key, path]) => {
    if (!EVIDENCE_KEY_PATTERN.test(key) || typeof path !== "string") {
      throw new EvidenceUploadError("INVALID_MANIFEST");
    }
    return [key, directChildPath(runDirectory, path)];
  });
}

export class EvidenceUploader {
  private readonly api: EvidenceUploadApi;
  private readonly workRoot: string;
  private readonly fileSystem: EvidenceFileSystem;
  private readonly uploadedByRun = new Map<string, Set<string>>();

  constructor(api: EvidenceUploadApi, workRoot: string, options: EvidenceUploaderOptions = {}) {
    this.api = api;
    this.workRoot = resolve(workRoot);
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  async upload(
    runId: string,
    manifest: Record<string, string>
  ): Promise<{ uploadedCount: number; totalCount: number }> {
    if (!SAFE_RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
      throw new EvidenceUploadError("INVALID_RUN_ID");
    }
    const runDirectory = resolve(this.workRoot, runId);
    if (!isStrictDescendant(this.workRoot, runDirectory)) {
      throw new EvidenceUploadError("INVALID_PATH");
    }
    const entries = validateManifest(manifest, runDirectory);

    let realWorkRoot: string;
    let realRunDirectory: string;
    let runIdentity: Stats;
    try {
      realWorkRoot = await this.fileSystem.realpath(this.workRoot);
      const configuredRunMetadata = await this.fileSystem.lstat(runDirectory);
      if (configuredRunMetadata.isSymbolicLink() || !configuredRunMetadata.isDirectory()) {
        throw new EvidenceUploadError("INVALID_PATH");
      }
      realRunDirectory = await this.fileSystem.realpath(runDirectory);
      const workMetadata = await this.fileSystem.lstat(realWorkRoot);
      const runMetadata = await this.fileSystem.lstat(realRunDirectory);
      if (!workMetadata.isDirectory() || workMetadata.isSymbolicLink()
        || !runMetadata.isDirectory() || runMetadata.isSymbolicLink()
        || !sameIdentity(configuredRunMetadata, runMetadata)) {
        throw new EvidenceUploadError("INVALID_PATH");
      }
      runIdentity = runMetadata;
    } catch (error) {
      if (error instanceof EvidenceUploadError) throw error;
      throw new EvidenceUploadError("READ_FAILED");
    }
    if (!isStrictDescendant(realWorkRoot, realRunDirectory)) {
      throw new EvidenceUploadError("INVALID_PATH");
    }
    const uploaded = this.uploadedByRun.get(runId) ?? new Set<string>();
    this.uploadedByRun.set(runId, uploaded);

    for (const [evidenceKey, candidate] of entries) {
      if (uploaded.has(evidenceKey)) continue;
      let expectedMetadata: Stats;
      try {
        await this.requireRunIdentity(runDirectory, runIdentity);
        const candidateMetadata = await this.fileSystem.lstat(candidate);
        if (candidateMetadata.isSymbolicLink() || !candidateMetadata.isFile()) {
          throw new EvidenceUploadError("INVALID_PATH");
        }
        expectedMetadata = candidateMetadata;
      } catch (error) {
        if (error instanceof EvidenceUploadError) throw error;
        throw new EvidenceUploadError("READ_FAILED");
      }

      const bytes = await this.readValidatedFile(
        candidate,
        expectedMetadata,
        runDirectory,
        runIdentity
      );
      if (!hasPngSignature(bytes)) throw new EvidenceUploadError("INVALID_PNG");
      const actualKey = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actualKey !== evidenceKey) throw new EvidenceUploadError("HASH_MISMATCH");

      const acknowledgement = await this.api.uploadEvidence(runId, evidenceKey, bytes);
      if (acknowledgement.evidenceKey !== evidenceKey) {
        throw new EvidenceUploadError("ACKNOWLEDGEMENT_MISMATCH");
      }
      uploaded.add(evidenceKey);
    }

    return {
      uploadedCount: entries.filter(([key]) => uploaded.has(key)).length,
      totalCount: entries.length
    };
  }

  clear(runId: string): void {
    this.uploadedByRun.delete(runId);
  }

  private async requireRunIdentity(path: string, expectedMetadata: Stats): Promise<void> {
    const metadata = await this.fileSystem.lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || !sameIdentity(metadata, expectedMetadata)) {
      throw new EvidenceUploadError("INVALID_PATH");
    }
  }

  private async requireFileIdentity(path: string, expectedMetadata: Stats): Promise<void> {
    const metadata = await this.fileSystem.lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || !sameIdentity(metadata, expectedMetadata)) {
      throw new EvidenceUploadError("INVALID_PATH");
    }
  }

  private async readValidatedFile(
    path: string,
    expectedMetadata: Stats,
    runDirectory: string,
    runIdentity: Stats
  ): Promise<Uint8Array> {
    let handle: FileHandle | undefined;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      handle = await this.fileSystem.open(path, constants.O_RDONLY | noFollow);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new EvidenceUploadError("INVALID_PATH");
      if (!sameIdentity(metadata, expectedMetadata)) {
        throw new EvidenceUploadError("INVALID_PATH");
      }
      await this.requireRunIdentity(runDirectory, runIdentity);
      if (metadata.size > MAX_EVIDENCE_BYTES) {
        throw new EvidenceUploadError("PAYLOAD_TOO_LARGE");
      }
      const bytes = Uint8Array.from(await handle.readFile());
      await this.requireFileIdentity(path, expectedMetadata);
      await this.requireRunIdentity(runDirectory, runIdentity);
      if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
        throw new EvidenceUploadError("PAYLOAD_TOO_LARGE");
      }
      return bytes;
    } catch (error) {
      if (error instanceof EvidenceUploadError) throw error;
      throw new EvidenceUploadError("READ_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
