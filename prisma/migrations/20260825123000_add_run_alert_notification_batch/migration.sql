-- CreateEnum
CREATE TYPE "RunAlertNotificationState" AS ENUM ('PENDING', 'SENDING', 'NOTIFIED');

-- CreateTable
CREATE TABLE "RunAlertNotificationBatch" (
    "id" TEXT NOT NULL,
    "collectionRunId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "alertIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "RunAlertNotificationState" NOT NULL DEFAULT 'PENDING',
    "attemptToken" VARCHAR(80),
    "attemptStartedAt" TIMESTAMP(3),
    "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastNotificationError" VARCHAR(120),
    "lastNotificationAttemptAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunAlertNotificationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunAlertNotificationBatch_collectionRunId_key"
ON "RunAlertNotificationBatch"("collectionRunId");

-- CreateIndex
CREATE INDEX "RunAlertNotificationBatch_state_attemptStartedAt_idx"
ON "RunAlertNotificationBatch"("state", "attemptStartedAt");

-- AddForeignKey
ALTER TABLE "RunAlertNotificationBatch"
ADD CONSTRAINT "RunAlertNotificationBatch_collectionRunId_fkey"
FOREIGN KEY ("collectionRunId") REFERENCES "CollectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
