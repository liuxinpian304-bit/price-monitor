import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CollectorReport } from "@stau-price-monitor/contracts";

export interface CollectorCheckpoint {
  schemaVersion: 1;
  checkpointFormatVersion: 2;
  runId: string;
  jobHash: string;
  phase: "OWN_LISTINGS" | "SEARCH" | "ITEMS" | "COMPLETE";
  completedOwnListingIds: string[];
  completedPlatformItemIds: string[];
  completedSkuKeys: string[];
  report: CollectorReport;
  evidenceManifest: Record<string, string>;
  identityAliases: Record<string, string>;
}

const CHECKPOINT_PHASES = new Set(["OWN_LISTINGS", "SEARCH", "ITEMS", "COMPLETE"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function hasReportShape(value: unknown): value is CollectorReport {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && typeof value.runId === "string"
    && typeof value.collectorId === "string"
    && typeof value.appVersion === "string"
    && typeof value.startedAt === "string"
    && typeof value.completedAt === "string"
    && typeof value.status === "string"
    && typeof value.searchLimit === "number"
    && Array.isArray(value.positions)
    && Array.isArray(value.ownItems)
    && Array.isArray(value.competitorItems)
    && Array.isArray(value.issues);
}

function parseCheckpoint(value: unknown, expectedRunId: string): CollectorCheckpoint {
  if (!isRecord(value)) throw new TypeError("Checkpoint must be a JSON object");
  if (value.checkpointFormatVersion !== 2) {
    throw new TypeError("Unsupported checkpoint format version; restart the collection run");
  }
  if (value.schemaVersion !== 1
    || value.runId !== expectedRunId
    || typeof value.jobHash !== "string"
    || typeof value.phase !== "string"
    || !CHECKPOINT_PHASES.has(value.phase)
    || !isStringArray(value.completedOwnListingIds)
    || !isStringArray(value.completedPlatformItemIds)
    || !isStringArray(value.completedSkuKeys)
    || !hasReportShape(value.report)
    || !isStringRecord(value.evidenceManifest)
    || !isStringRecord(value.identityAliases)) {
    throw new TypeError("Checkpoint does not match the current runtime format");
  }
  return value as unknown as CollectorCheckpoint;
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..") {
    throw new TypeError("Checkpoint run ID must be a safe path segment");
  }
}

export class AtomicCheckpointStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  pathFor(runId: string): string {
    assertSafeRunId(runId);
    return join(this.rootDirectory, runId, "checkpoint.json");
  }

  async load(runId: string): Promise<CollectorCheckpoint | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.pathFor(runId), "utf8"));
      return parseCheckpoint(parsed, runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(runId: string, state: CollectorCheckpoint): Promise<void> {
    if (state.runId !== runId) {
      throw new TypeError("Checkpoint run ID does not match its storage key");
    }

    const checkpointPath = this.pathFor(runId);
    const runDirectory = dirname(checkpointPath);
    await mkdir(runDirectory, { recursive: true });

    const temporaryPath = join(runDirectory, `.checkpoint-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, checkpointPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async remove(runId: string): Promise<void> {
    await rm(this.pathFor(runId), { force: true });
  }
}
