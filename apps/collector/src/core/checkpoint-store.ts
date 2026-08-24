import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CollectorReport } from "@stau-price-monitor/contracts";

export interface CollectorCheckpoint {
  schemaVersion: 1;
  runId: string;
  jobHash: string;
  phase: "OWN_LISTINGS" | "SEARCH" | "ITEMS" | "COMPLETE";
  completedOwnListingIds: string[];
  completedPlatformItemIds: string[];
  completedSkuKeys: string[];
  report: CollectorReport;
  evidenceManifest: Record<string, string>;
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
      return JSON.parse(await readFile(this.pathFor(runId), "utf8")) as CollectorCheckpoint;
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
