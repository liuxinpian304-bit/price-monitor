-- Preserve the exact claimed job so an ownership-fenced stale lease resumes its original checkpoint contract.
ALTER TABLE "CollectionRun" ADD COLUMN "claimedJob" JSONB;

-- Alert evaluation and delivery are independently durable across process restarts.
ALTER TABLE "CollectionRun"
  ADD COLUMN "alertEvaluationToken" VARCHAR(80),
  ADD COLUMN "alertEvaluationStartedAt" TIMESTAMP(3),
  ADD COLUMN "alertEvaluationLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "alertEvaluationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alertEvaluatedAt" TIMESTAMP(3),
  ADD COLUMN "alertEvaluationError" VARCHAR(120),
  ADD COLUMN "ownBaselineSnapshotId" TEXT;

ALTER TYPE "RunAlertNotificationState" ADD VALUE 'AMBIGUOUS' BEFORE 'FAILED';

-- Nullable termination preserves old reports while new reports distinguish the limit from a verified page end.
CREATE TYPE "SearchTerminationReason" AS ENUM ('LIMIT_REACHED', 'END_MARKER');
ALTER TABLE "CollectionRun" ADD COLUMN "searchTerminationReason" "SearchTerminationReason";

CREATE INDEX "CollectionRun_alertEvaluatedAt_alertEvaluationLastAttemptAt_idx"
  ON "CollectionRun"("alertEvaluatedAt", "alertEvaluationLastAttemptAt");
CREATE INDEX "CollectionRun_ownBaselineSnapshotId_idx"
  ON "CollectionRun"("ownBaselineSnapshotId");

ALTER TABLE "CollectionRun"
  ADD CONSTRAINT "CollectionRun_ownBaselineSnapshotId_fkey"
  FOREIGN KEY ("ownBaselineSnapshotId") REFERENCES "OfferSnapshot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
