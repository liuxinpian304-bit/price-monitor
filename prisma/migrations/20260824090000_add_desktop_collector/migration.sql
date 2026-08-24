-- CreateEnum
CREATE TYPE "CollectorPlatform" AS ENUM ('MACOS', 'WINDOWS');

-- CreateEnum
CREATE TYPE "PriceConfidence" AS ENUM ('CONFIRMED', 'ESTIMATED', 'MANUAL_REVIEW');

-- AlterEnum
ALTER TYPE "CollectionRunStatus" ADD VALUE 'PAUSED_LOGIN';
ALTER TYPE "CollectionRunStatus" ADD VALUE 'PAUSED_CHALLENGE';
ALTER TYPE "CollectionRunStatus" ADD VALUE 'COALESCED';

-- AlterTable
ALTER TABLE "CollectionRun"
  ADD COLUMN "collectorAgentId" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "searchLimit" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "coalescedIntoRunId" TEXT,
  ADD COLUMN "discoveredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skuCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "incompleteCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OfferSnapshot"
  ADD COLUMN "activityPriceFen" INTEGER,
  ADD COLUMN "couponDiscountFen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fullReductionFen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "directDiscountFen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mandatoryFeeFen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "priceConfidence" "PriceConfidence" NOT NULL DEFAULT 'MANUAL_REVIEW',
  ADD COLUMN "evidenceKey" VARCHAR(80),
  ADD COLUMN "ingestionKey" VARCHAR(80),
  ADD COLUMN "matchDecision" "CandidateDecision",
  ADD COLUMN "comparable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "matchConfidenceBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "normalizedModel" VARCHAR(300),
  ADD COLUMN "matchReasons" JSONB;

-- CreateTable
CREATE TABLE "CollectorAgent" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "platform" "CollectorPlatform" NOT NULL,
  "tokenHash" VARCHAR(160) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "appVersion" VARCHAR(120),
  "capabilities" JSONB,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CollectorAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionSearchPosition" (
  "id" TEXT NOT NULL,
  "collectionRunId" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "platformItemId" VARCHAR(160) NOT NULL,
  "url" TEXT NOT NULL,
  "shopName" VARCHAR(200) NOT NULL,
  "title" VARCHAR(1000) NOT NULL,
  "displayPriceMinFen" INTEGER NOT NULL,
  "displayPriceMaxFen" INTEGER NOT NULL,
  "sponsored" BOOLEAN NOT NULL DEFAULT false,
  "capturedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CollectionSearchPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionIssue" (
  "id" TEXT NOT NULL,
  "collectionRunId" TEXT NOT NULL,
  "issueKey" VARCHAR(80) NOT NULL,
  "code" VARCHAR(120) NOT NULL,
  "platformItemId" VARCHAR(160),
  "skuId" VARCHAR(160),
  "message" TEXT NOT NULL,
  "evidenceKey" VARCHAR(80),
  "capturedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CollectionIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectorAgent_name_key" ON "CollectorAgent"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CollectorAgent_tokenHash_key" ON "CollectorAgent"("tokenHash");

-- CreateIndex
CREATE INDEX "CollectionRun_collectorAgentId_idx" ON "CollectionRun"("collectorAgentId");

-- CreateIndex
CREATE INDEX "CollectionRun_coalescedIntoRunId_idx" ON "CollectionRun"("coalescedIntoRunId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionSearchPosition_collectionRunId_rank_key" ON "CollectionSearchPosition"("collectionRunId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionIssue_issueKey_key" ON "CollectionIssue"("issueKey");

-- CreateIndex
CREATE INDEX "CollectionIssue_collectionRunId_idx" ON "CollectionIssue"("collectionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferSnapshot_ingestionKey_key" ON "OfferSnapshot"("ingestionKey");

-- AddForeignKey
ALTER TABLE "CollectionRun" ADD CONSTRAINT "CollectionRun_collectorAgentId_fkey" FOREIGN KEY ("collectorAgentId") REFERENCES "CollectorAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRun" ADD CONSTRAINT "CollectionRun_coalescedIntoRunId_fkey" FOREIGN KEY ("coalescedIntoRunId") REFERENCES "CollectionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionSearchPosition" ADD CONSTRAINT "CollectionSearchPosition_collectionRunId_fkey" FOREIGN KEY ("collectionRunId") REFERENCES "CollectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionIssue" ADD CONSTRAINT "CollectionIssue_collectionRunId_fkey" FOREIGN KEY ("collectionRunId") REFERENCES "CollectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
