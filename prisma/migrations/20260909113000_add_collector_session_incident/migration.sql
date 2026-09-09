CREATE TABLE "CollectorSessionIncident" (
    "id" TEXT NOT NULL,
    "collectorAgentId" TEXT NOT NULL,
    "state" "CollectorSessionState" NOT NULL,
    "activeKey" VARCHAR(200),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    "notificationState" "RunAlertNotificationState" NOT NULL DEFAULT 'PENDING',
    "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "notifiedAt" TIMESTAMP(3),
    "lastNotificationError" VARCHAR(120),

    CONSTRAINT "CollectorSessionIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollectorSessionIncident_activeKey_key"
ON "CollectorSessionIncident"("activeKey");

CREATE INDEX "CollectorSessionIncident_collectorAgentId_openedAt_idx"
ON "CollectorSessionIncident"("collectorAgentId", "openedAt");

CREATE INDEX "CollectorSessionIncident_notificationState_openedAt_idx"
ON "CollectorSessionIncident"("notificationState", "openedAt");

ALTER TABLE "CollectorSessionIncident"
ADD CONSTRAINT "CollectorSessionIncident_collectorAgentId_fkey"
FOREIGN KEY ("collectorAgentId") REFERENCES "CollectorAgent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
