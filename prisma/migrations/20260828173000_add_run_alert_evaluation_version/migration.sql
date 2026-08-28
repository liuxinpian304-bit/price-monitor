ALTER TABLE "CollectionRun"
  ADD COLUMN "alertEvaluationVersion" VARCHAR(80);

CREATE INDEX "CollectionRun_alertEvaluationVersion_alertEvaluatedAt_alertEvaluationLastAttemptAt_idx"
  ON "CollectionRun"("alertEvaluationVersion", "alertEvaluatedAt", "alertEvaluationLastAttemptAt");
