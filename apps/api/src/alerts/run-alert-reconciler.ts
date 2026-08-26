import type { RunAlertSummary } from "../collection/run-alert.service.ts";

export interface ClaimedRunAlertEvaluation {
  runId: string;
  attemptToken: string;
}

export interface RunAlertEvaluationRepository {
  claimRun(
    runId: string | null,
    attemptedAt: Date
  ): Promise<ClaimedRunAlertEvaluation | null>;
  markEvaluated(claim: ClaimedRunAlertEvaluation, completedAt: Date): Promise<void>;
  recordEvaluationFailure(claim: ClaimedRunAlertEvaluation, failedAt: Date): Promise<void>;
}

export interface RunAlertReconciliationScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export class RunAlertReconciler {
  private readonly evaluations: RunAlertEvaluationRepository;
  private readonly evaluator: { evaluateRun(runId: string): Promise<RunAlertSummary> };
  private readonly notifier: { send(summary: RunAlertSummary): Promise<void> };
  private readonly pendingNotifications: {
    listRetryableSummaries(attemptedAt: Date, limit: number): Promise<RunAlertSummary[]>;
  };
  private readonly now: () => Date;

  constructor(
    evaluations: RunAlertEvaluationRepository,
    evaluator: { evaluateRun(runId: string): Promise<RunAlertSummary> },
    notifier: { send(summary: RunAlertSummary): Promise<void> },
    pendingNotifications: {
      listRetryableSummaries(attemptedAt: Date, limit: number): Promise<RunAlertSummary[]>;
    },
    now: () => Date = () => new Date()
  ) {
    this.evaluations = evaluations;
    this.evaluator = evaluator;
    this.notifier = notifier;
    this.pendingNotifications = pendingNotifications;
    this.now = now;
  }

  async reconcileRun(runId: string): Promise<void> {
    const attemptedAt = this.now();
    const claim = await this.evaluations.claimRun(runId, attemptedAt);
    if (claim) await this.evaluateClaim(claim);
  }

  async reconcilePending(limit = 25): Promise<void> {
    const attemptedAt = this.now();
    const summaries = await this.pendingNotifications.listRetryableSummaries(attemptedAt, limit);
    for (const summary of summaries) await this.notifier.send(summary);

    for (let index = 0; index < limit; index += 1) {
      const claim = await this.evaluations.claimRun(null, attemptedAt);
      if (!claim) break;
      await this.evaluateClaim(claim);
    }
  }

  private async evaluateClaim(claim: ClaimedRunAlertEvaluation): Promise<void> {
    try {
      const summary = await this.evaluator.evaluateRun(claim.runId);
      await this.notifier.send(summary);
      await this.evaluations.markEvaluated(claim, this.now());
    } catch {
      await this.evaluations.recordEvaluationFailure(claim, this.now());
    }
  }
}

const defaultScheduler: RunAlertReconciliationScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export class RunAlertReconciliationLoop {
  private handle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private readonly reconciler: { reconcilePending(): Promise<void> };
  private readonly scheduler: RunAlertReconciliationScheduler;
  private readonly intervalMilliseconds: number;

  constructor(
    reconciler: { reconcilePending(): Promise<void> },
    scheduler: RunAlertReconciliationScheduler = defaultScheduler,
    intervalMilliseconds = 30_000
  ) {
    this.reconciler = reconciler;
    this.scheduler = scheduler;
    this.intervalMilliseconds = intervalMilliseconds;
  }

  async start(): Promise<void> {
    if (this.handle !== null) return;
    await this.runOnce();
    this.handle = this.scheduler.setInterval(() => { void this.runOnce(); }, this.intervalMilliseconds);
  }

  async close(): Promise<void> {
    if (this.handle !== null) this.scheduler.clearInterval(this.handle);
    this.handle = null;
    await this.inFlight;
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconciler.reconcilePending()
      .catch(() => undefined)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
