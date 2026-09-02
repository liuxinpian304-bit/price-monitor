import {
  collectorJobSchema,
  collectorReportSchema,
  type CollectorRunReleaseInput,
  type CollectorJob,
  type CollectorReport
} from "@stau-price-monitor/contracts";

import type { CollectorCheckpoint } from "../core/checkpoint-store.ts";
import { CollectionInterruptedError } from "../core/collection-runner.ts";
import type { IngestionSummary } from "./collector-api-client.ts";

export interface CollectorWorkerApi {
  claim(input: { appVersion: string; capabilities: string[] }): Promise<CollectorJob | null>;
  heartbeat(
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<void>;
  pause(
    runId: string,
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<void>;
  release(runId: string, input?: CollectorRunReleaseInput): Promise<void>;
  uploadReport(runId: string, report: CollectorReport): Promise<IngestionSummary>;
}

export interface CollectorWorkerRunner {
  run(job: CollectorJob, collectorId: string, signal: AbortSignal): Promise<CollectorReport>;
  close?(): void;
}

export interface CollectorWorkerCheckpoint {
  phase: CollectorCheckpoint["phase"];
  completedSkuKeys: string[];
  report: CollectorReport;
  evidenceManifest: Record<string, string>;
}

export interface CollectorWorkerCheckpointStore {
  load(runId: string): Promise<CollectorWorkerCheckpoint | null>;
  remove(runId: string): Promise<void>;
}

export interface WorkerEvidenceUploader {
  upload(
    runId: string,
    manifest: Record<string, string>
  ): Promise<{ uploadedCount: number; totalCount: number }>;
  clear(runId: string): void;
}

export interface WorkerScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CollectorLogSummary {
  event: string;
  runId: string | null;
  phase: string | null;
  discoveredCount: number;
  skuCount: number;
  errorCode: string | null;
}

export interface CollectorWorkerOptions {
  api: CollectorWorkerApi;
  checkpointStore: CollectorWorkerCheckpointStore;
  evidenceUploader: WorkerEvidenceUploader;
  runnerFactory: (runId: string) => CollectorWorkerRunner;
  appVersion: string;
  capabilities: string[];
  scheduler?: WorkerScheduler;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log?: (summary: CollectorLogSummary) => void;
}

export class CollectorWorkerError extends Error {
  readonly code:
    | "ALREADY_RUNNING"
    | "INVALID_JOB"
    | "INVALID_REPORT"
    | "RUNNER_INITIALIZATION_FAILED"
    | "COLLECTION_FAILED"
    | "CHECKPOINT_FAILED";
  readonly transient = false;

  constructor(code: CollectorWorkerError["code"]) {
    super(`Collector worker failed: ${code}`);
    this.name = "CollectorWorkerError";
    this.code = code;
  }
}

const CLAIM_WAIT_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

const defaultScheduler: WorkerScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNEXPECTED_ERROR";
  let code: unknown;
  try {
    code = Reflect.get(error, "code");
  } catch {
    return "UNEXPECTED_ERROR";
  }
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "UNEXPECTED_ERROR";
}

function isTransient(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "transient") === true;
}

class HeartbeatLoop {
  private readonly runId: string;
  private readonly api: CollectorWorkerApi;
  private readonly checkpointStore: CollectorWorkerCheckpointStore;
  private readonly scheduler: WorkerScheduler;
  private readonly monotonicNow: () => number;
  private readonly log: (summary: CollectorLogSummary) => void;
  private active = true;
  private timer: unknown;
  private pending: Promise<void> | null = null;
  private nextDeadline: number;

  constructor(options: {
    runId: string;
    api: CollectorWorkerApi;
    checkpointStore: CollectorWorkerCheckpointStore;
    scheduler: WorkerScheduler;
    monotonicNow: () => number;
    log: (summary: CollectorLogSummary) => void;
  }) {
    this.runId = options.runId;
    this.api = options.api;
    this.checkpointStore = options.checkpointStore;
    this.scheduler = options.scheduler;
    this.monotonicNow = options.monotonicNow;
    this.log = options.log;
    const startedAt = this.monotonicNow();
    this.nextDeadline = startedAt + HEARTBEAT_INTERVAL_MS;
    this.scheduleDeadline(startedAt);
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  private scheduleDeadline(now = this.monotonicNow()): void {
    if (!this.active) return;
    const delay = Math.max(0, this.nextDeadline - now);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      if (!this.active) return;
      const now = this.monotonicNow();
      do {
        this.nextDeadline += HEARTBEAT_INTERVAL_MS;
      } while (this.nextDeadline <= now);
      if (this.pending === null) this.startHeartbeat();
      this.scheduleDeadline();
    }, delay);
  }

  private startHeartbeat(): void {
    if (!this.active || this.pending !== null) return;
    this.pending = this.send()
      .catch((error: unknown) => {
        this.log({
          event: "heartbeat_failed",
          runId: this.runId,
          phase: null,
          discoveredCount: 0,
          skuCount: 0,
          errorCode: safeErrorCode(error)
        });
      })
      .finally(() => {
        this.pending = null;
      });
  }

  private async send(): Promise<void> {
    const checkpoint = await this.checkpointStore.load(this.runId);
    const discoveredCount = checkpoint?.report.positions.length ?? 0;
    const skuCount = checkpoint?.completedSkuKeys.length ?? 0;
    await this.api.heartbeat(this.runId, { discoveredCount, skuCount });
    this.log({
      event: "heartbeat_sent",
      runId: this.runId,
      phase: checkpoint?.phase ?? null,
      discoveredCount,
      skuCount,
      errorCode: null
    });
  }
}

export type OnceResult = "idle" | "processed" | "paused" | "stopped";

export class CollectorWorker {
  private readonly options: Required<Pick<CollectorWorkerOptions, "api" | "checkpointStore"
    | "evidenceUploader" | "runnerFactory" | "appVersion" | "capabilities">>
    & Pick<CollectorWorkerOptions, "log">;
  private readonly scheduler: WorkerScheduler;
  private readonly monotonicNow: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly stopController = new AbortController();
  private activeController: AbortController | null = null;
  private running = false;

  constructor(options: CollectorWorkerOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  stop(): void {
    this.stopController.abort();
    this.activeController?.abort();
  }

  async once(): Promise<OnceResult> {
    return this.exclusive(async () => {
      const claimed = await this.claim();
      if (claimed === "stopped" || claimed === null) return claimed === null ? "idle" : claimed;
      return this.processJob(claimed);
    });
  }

  async run(): Promise<void> {
    await this.exclusive(async () => {
      while (!this.stopController.signal.aborted) {
        let claimed: CollectorJob | null | "stopped";
        try {
          claimed = await this.claim();
        } catch (error) {
          if (!isTransient(error)) throw error;
          this.emit({
            event: "claim_failed",
            runId: null,
            phase: null,
            discoveredCount: 0,
            skuCount: 0,
            errorCode: safeErrorCode(error)
          });
          if (!this.stopController.signal.aborted) {
            await this.sleep(CLAIM_WAIT_MS, this.stopController.signal);
          }
          continue;
        }
        if (claimed === "stopped") break;
        const result = claimed === null ? "idle" : await this.processJob(claimed);
        if (result === "stopped") break;
        if (result === "idle" && !this.stopController.signal.aborted) {
          await this.sleep(CLAIM_WAIT_MS, this.stopController.signal);
        }
      }
    });
  }

  private async claim(): Promise<CollectorJob | null | "stopped"> {
    if (this.stopController.signal.aborted) return "stopped";
    const inputJob = await this.options.api.claim({
      appVersion: this.options.appVersion,
      capabilities: [...this.options.capabilities]
    });
    if (inputJob === null) return null;
    const parsedJob = collectorJobSchema.safeParse(inputJob);
    if (!parsedJob.success) throw new CollectorWorkerError("INVALID_JOB");
    return parsedJob.data;
  }

  private async processJob(job: CollectorJob): Promise<OnceResult> {
    const controller = new AbortController();
    this.activeController = controller;
    if (this.stopController.signal.aborted) controller.abort();
    let runner: CollectorWorkerRunner;
    try {
      runner = this.options.runnerFactory(job.runId);
    } catch {
      this.activeController = null;
      await this.release(job.runId);
      throw new CollectorWorkerError("RUNNER_INITIALIZATION_FAILED");
    }
    const heartbeat = new HeartbeatLoop({
      runId: job.runId,
      api: this.options.api,
      checkpointStore: this.options.checkpointStore,
      scheduler: this.scheduler,
      monotonicNow: this.monotonicNow,
      log: (summary) => this.emit(summary)
    });

    let inputReport: CollectorReport | undefined;
    let runnerError: unknown;
    try {
      inputReport = await runner.run(job, job.collectorId, controller.signal);
    } catch (error) {
      runnerError = error;
    }
    await heartbeat.stop();
    try {
      runner.close?.();
    } catch {
      // Cleanup errors are intentionally suppressed; no helper diagnostic is safe to propagate here.
    }
    if (runnerError !== undefined) {
      this.activeController = null;
      if (runnerError instanceof CollectionInterruptedError) {
        await this.release(job.runId);
        return "stopped";
      }
      if (safeErrorCode(runnerError) === "INVALID_CHECKPOINT") {
        await this.release(job.runId, {
          disposition: "QUARANTINE",
          errorCode: "INVALID_CHECKPOINT"
        });
        throw new CollectorWorkerError("CHECKPOINT_FAILED");
      }
      await this.release(job.runId);
      throw new CollectorWorkerError("COLLECTION_FAILED");
    }
    if (inputReport === undefined) {
      this.activeController = null;
      await this.release(job.runId);
      throw new CollectorWorkerError("INVALID_REPORT");
    }

    const parsedReport = collectorReportSchema.safeParse(inputReport);
    if (!parsedReport.success || parsedReport.data.runId !== job.runId
      || parsedReport.data.collectorId !== job.collectorId) {
      this.activeController = null;
      await this.release(job.runId);
      throw new CollectorWorkerError("INVALID_REPORT");
    }
    const report = parsedReport.data;

    if (report.status === "PAUSED_LOGIN" || report.status === "PAUSED_CHALLENGE") {
      const code = report.status === "PAUSED_LOGIN" ? "LOGIN_REQUIRED" : "PLATFORM_CHALLENGE";
      const message = code === "LOGIN_REQUIRED"
        ? "Operator login required"
        : "Platform challenge requires operator review";
      await this.options.api.pause(job.runId, code, message);
      this.activeController = null;
      this.emit({
        event: "job_paused",
        runId: job.runId,
        phase: report.status,
        discoveredCount: report.positions.length,
        skuCount: this.reportSkuCount(report),
        errorCode: code
      });
      return "paused";
    }

    let checkpoint: CollectorWorkerCheckpoint | null;
    try {
      checkpoint = await this.options.checkpointStore.load(job.runId);
    } catch (error) {
      this.activeController = null;
      if (safeErrorCode(error) === "INVALID_CHECKPOINT") {
        await this.release(job.runId, {
          disposition: "QUARANTINE",
          errorCode: "INVALID_CHECKPOINT"
        });
      } else {
        await this.release(job.runId);
      }
      throw new CollectorWorkerError("CHECKPOINT_FAILED");
    }
    try {
      if (checkpoint !== null) {
        await this.retryTransient(
          () => this.options.evidenceUploader.upload(job.runId, checkpoint.evidenceManifest),
          job.runId,
          "evidence_upload",
          controller.signal
        );
      }
      await this.retryTransient(
        () => this.options.api.uploadReport(job.runId, report),
        job.runId,
        "report_upload",
        controller.signal
      );
    } catch (error) {
      this.activeController = null;
      await this.release(job.runId);
      if (error instanceof CollectionInterruptedError) return "stopped";
      throw error;
    }

    if (checkpoint !== null) {
      try {
        await this.options.checkpointStore.remove(job.runId);
      } catch {
        this.activeController = null;
        throw new CollectorWorkerError("CHECKPOINT_FAILED");
      }
    }
    this.options.evidenceUploader.clear(job.runId);
    this.activeController = null;
    this.emit({
      event: "job_acknowledged",
      runId: job.runId,
      phase: report.status,
      discoveredCount: report.positions.length,
      skuCount: this.reportSkuCount(report),
      errorCode: null
    });
    return "processed";
  }

  private async retryTransient<T>(
    operation: () => Promise<T>,
    runId: string,
    phase: string,
    signal: AbortSignal
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new CollectionInterruptedError();
      try {
        return await operation();
      } catch (error) {
        if (!isTransient(error) || attempt === 2) throw error;
        this.emit({
          event: "upload_retry",
          runId,
          phase,
          discoveredCount: 0,
          skuCount: 0,
          errorCode: safeErrorCode(error)
        });
        await this.sleep(RETRY_DELAYS_MS[attempt]!, signal);
      }
    }
    throw new CollectorWorkerError("INVALID_REPORT");
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) throw new CollectorWorkerError("ALREADY_RUNNING");
    this.running = true;
    try {
      return await operation();
    } finally {
      this.running = false;
      this.activeController = null;
    }
  }

  private reportSkuCount(report: CollectorReport): number {
    return [...report.ownItems, ...report.competitorItems]
      .reduce((total, item) => total + item.skus.length, 0);
  }

  private async release(runId: string, input?: CollectorRunReleaseInput): Promise<void> {
    const quarantined = input?.disposition === "QUARANTINE";
    try {
      await this.options.api.release(runId, input);
      this.emit({
        event: quarantined ? "job_quarantined" : "job_requeued",
        runId,
        phase: null,
        discoveredCount: 0,
        skuCount: 0,
        errorCode: quarantined ? "INVALID_CHECKPOINT" : null
      });
    } catch (error) {
      this.emit({
        event: quarantined ? "job_quarantine_failed" : "job_requeue_failed",
        runId,
        phase: null,
        discoveredCount: 0,
        skuCount: 0,
        errorCode: safeErrorCode(error)
      });
    }
  }

  private emit(summary: CollectorLogSummary): void {
    (this.options.log ?? ((value) => console.log(JSON.stringify(value))))(summary);
  }
}
