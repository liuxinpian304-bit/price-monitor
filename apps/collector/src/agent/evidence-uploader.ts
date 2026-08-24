import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface EvidenceUploadApi {
  uploadEvidence(
    runId: string,
    evidenceKey: string,
    bytes: Uint8Array
  ): Promise<{ evidenceKey: string }>;
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

function isStrictDescendant(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function validateManifest(manifest: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(manifest);
  if (entries.some(([key, path]) => !EVIDENCE_KEY_PATTERN.test(key)
    || typeof path !== "string" || path.length === 0)) {
    throw new EvidenceUploadError("INVALID_MANIFEST");
  }
  return entries;
}

export class EvidenceUploader {
  private readonly api: EvidenceUploadApi;
  private readonly workRoot: string;
  private readonly uploadedByRun = new Map<string, Set<string>>();

  constructor(api: EvidenceUploadApi, workRoot: string) {
    this.api = api;
    this.workRoot = resolve(workRoot);
  }

  async upload(
    runId: string,
    manifest: Record<string, string>
  ): Promise<{ uploadedCount: number; totalCount: number }> {
    if (!SAFE_RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
      throw new EvidenceUploadError("INVALID_RUN_ID");
    }
    const entries = validateManifest(manifest);
    const runDirectory = resolve(this.workRoot, runId);
    if (!isStrictDescendant(this.workRoot, runDirectory)) {
      throw new EvidenceUploadError("INVALID_PATH");
    }

    let realRunDirectory: string;
    try {
      realRunDirectory = await realpath(runDirectory);
    } catch {
      throw new EvidenceUploadError("READ_FAILED");
    }
    const uploaded = this.uploadedByRun.get(runId) ?? new Set<string>();
    this.uploadedByRun.set(runId, uploaded);

    for (const [evidenceKey, manifestPath] of entries) {
      if (uploaded.has(evidenceKey)) continue;
      const candidate = resolve(runDirectory, manifestPath);
      if (!isStrictDescendant(runDirectory, candidate)) {
        throw new EvidenceUploadError("INVALID_PATH");
      }

      let realCandidate: string;
      try {
        realCandidate = await realpath(candidate);
      } catch {
        throw new EvidenceUploadError("READ_FAILED");
      }
      if (!isStrictDescendant(realRunDirectory, realCandidate)) {
        throw new EvidenceUploadError("INVALID_PATH");
      }

      const bytes = await this.readValidatedFile(realCandidate);
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

  private async readValidatedFile(path: string): Promise<Uint8Array> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new EvidenceUploadError("INVALID_PATH");
      if (metadata.size > MAX_EVIDENCE_BYTES) {
        throw new EvidenceUploadError("PAYLOAD_TOO_LARGE");
      }
      return Uint8Array.from(await handle.readFile());
    } catch (error) {
      if (error instanceof EvidenceUploadError) throw error;
      throw new EvidenceUploadError("READ_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
