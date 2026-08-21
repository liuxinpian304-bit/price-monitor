-- AlterTable
ALTER TABLE "PriceAlert" ADD COLUMN     "lastNotificationAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastNotificationError" TEXT,
ADD COLUMN     "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reasons" JSONB;
