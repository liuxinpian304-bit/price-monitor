-- AlterTable
ALTER TABLE "CollectionRun"
  ADD COLUMN "desktopReportDigest" VARCHAR(80),
  ADD COLUMN "desktopIngestionSummary" JSONB;
