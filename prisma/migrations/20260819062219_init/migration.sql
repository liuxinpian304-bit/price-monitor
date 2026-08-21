-- CreateEnum
CREATE TYPE "ComparisonType" AS ENUM ('BARE', 'BUNDLE');

-- CreateEnum
CREATE TYPE "AliasType" AS ENUM ('EFFECTIVE', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "CandidateDecision" AS ENUM ('PENDING', 'BARE', 'BUNDLE', 'REJECTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "StockState" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CollectionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'PRICE_CHANGED', 'NO_FOLLOW', 'FALSE_POSITIVE', 'WATCHING');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CONFIRMED_LOW', 'MANUAL_REVIEW', 'SYSTEM_ERROR');

-- CreateTable
CREATE TABLE "MonitoredModel" (
    "id" TEXT NOT NULL,
    "monitorCode" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "brand" VARCHAR(120) NOT NULL,
    "standardModel" VARCHAR(200) NOT NULL,
    "category" VARCHAR(120) NOT NULL,
    "searchQuery" VARCHAR(500) NOT NULL,
    "version" VARCHAR(200),
    "mustIncludeTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comparisonType" "ComparisonType" NOT NULL,
    "colorComparable" BOOLEAN NOT NULL DEFAULT false,
    "owner" VARCHAR(120) NOT NULL,
    "notes" TEXT,
    "bundleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoredModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelAlias" (
    "id" TEXT NOT NULL,
    "monitoredModelId" TEXT NOT NULL,
    "phrase" VARCHAR(300) NOT NULL,
    "type" "AliasType" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "title" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "accessoryType" VARCHAR(120) NOT NULL,
    "brand" VARCHAR(120),
    "modelOrName" VARCHAR(300) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitValueFen" INTEGER NOT NULL,
    "core" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnListing" (
    "id" TEXT NOT NULL,
    "monitoredModelId" TEXT NOT NULL,
    "platform" VARCHAR(40) NOT NULL DEFAULT 'TMALL',
    "shopName" VARCHAR(200) NOT NULL DEFAULT '星空乐器专营店',
    "platformItemId" VARCHAR(160),
    "url" TEXT NOT NULL,
    "skuText" VARCHAR(500) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchCandidate" (
    "id" TEXT NOT NULL,
    "monitoredModelId" TEXT NOT NULL,
    "providerKey" VARCHAR(100) NOT NULL,
    "platformItemId" VARCHAR(160) NOT NULL,
    "url" TEXT NOT NULL,
    "shopName" VARCHAR(200) NOT NULL,
    "title" VARCHAR(1000) NOT NULL,
    "decision" "CandidateDecision" NOT NULL DEFAULT 'PENDING',
    "comparable" BOOLEAN NOT NULL DEFAULT false,
    "confidenceBps" INTEGER NOT NULL DEFAULT 0,
    "normalizedModel" VARCHAR(300),
    "reasons" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionRun" (
    "id" TEXT NOT NULL,
    "monitoredModelId" TEXT NOT NULL,
    "providerKey" VARCHAR(100) NOT NULL,
    "status" "CollectionRunStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "searchedCount" INTEGER NOT NULL DEFAULT 0,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(120),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferSnapshot" (
    "id" TEXT NOT NULL,
    "collectionRunId" TEXT NOT NULL,
    "ownListingId" TEXT,
    "searchCandidateId" TEXT,
    "platformItemId" VARCHAR(160) NOT NULL,
    "skuId" VARCHAR(160),
    "shopName" VARCHAR(200) NOT NULL,
    "title" VARCHAR(1000) NOT NULL,
    "skuText" VARCHAR(500),
    "listPriceFen" INTEGER,
    "publicDiscountFen" INTEGER NOT NULL DEFAULT 0,
    "payableFen" INTEGER,
    "stockState" "StockState" NOT NULL DEFAULT 'UNKNOWN',
    "promotions" JSONB,
    "gifts" JSONB,
    "rawEvidence" JSONB,
    "evidenceUrl" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL,
    "monitoredModelId" TEXT NOT NULL,
    "ownSnapshotId" TEXT,
    "competitorSnapshotId" TEXT,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "dedupKey" VARCHAR(300) NOT NULL,
    "ownPriceFen" INTEGER,
    "competitorPriceFen" INTEGER,
    "differenceFen" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertAction" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "actorId" VARCHAR(160) NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "reasonCode" VARCHAR(120),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" VARCHAR(160) NOT NULL,
    "valueJson" JSONB,
    "encryptedValue" BYTEA,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" VARCHAR(160) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" VARCHAR(160) NOT NULL,
    "action" VARCHAR(200) NOT NULL,
    "entityType" VARCHAR(160) NOT NULL,
    "entityId" VARCHAR(200) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonitoredModel_monitorCode_key" ON "MonitoredModel"("monitorCode");

-- CreateIndex
CREATE INDEX "MonitoredModel_enabled_idx" ON "MonitoredModel"("enabled");

-- CreateIndex
CREATE INDEX "MonitoredModel_brand_standardModel_idx" ON "MonitoredModel"("brand", "standardModel");

-- CreateIndex
CREATE INDEX "MonitoredModel_bundleId_idx" ON "MonitoredModel"("bundleId");

-- CreateIndex
CREATE INDEX "ModelAlias_phrase_idx" ON "ModelAlias"("phrase");

-- CreateIndex
CREATE UNIQUE INDEX "ModelAlias_monitoredModelId_phrase_type_key" ON "ModelAlias"("monitoredModelId", "phrase", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_code_key" ON "Bundle"("code");

-- CreateIndex
CREATE INDEX "BundleItem_bundleId_idx" ON "BundleItem"("bundleId");

-- CreateIndex
CREATE INDEX "OwnListing_active_idx" ON "OwnListing"("active");

-- CreateIndex
CREATE UNIQUE INDEX "OwnListing_monitoredModelId_url_skuText_key" ON "OwnListing"("monitoredModelId", "url", "skuText");

-- CreateIndex
CREATE INDEX "SearchCandidate_decision_comparable_idx" ON "SearchCandidate"("decision", "comparable");

-- CreateIndex
CREATE INDEX "SearchCandidate_shopName_idx" ON "SearchCandidate"("shopName");

-- CreateIndex
CREATE UNIQUE INDEX "SearchCandidate_monitoredModelId_providerKey_platformItemId_key" ON "SearchCandidate"("monitoredModelId", "providerKey", "platformItemId");

-- CreateIndex
CREATE INDEX "CollectionRun_status_scheduledFor_idx" ON "CollectionRun"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_monitoredModelId_providerKey_scheduledFor_key" ON "CollectionRun"("monitoredModelId", "providerKey", "scheduledFor");

-- CreateIndex
CREATE INDEX "OfferSnapshot_collectionRunId_idx" ON "OfferSnapshot"("collectionRunId");

-- CreateIndex
CREATE INDEX "OfferSnapshot_ownListingId_capturedAt_idx" ON "OfferSnapshot"("ownListingId", "capturedAt");

-- CreateIndex
CREATE INDEX "OfferSnapshot_searchCandidateId_capturedAt_idx" ON "OfferSnapshot"("searchCandidateId", "capturedAt");

-- CreateIndex
CREATE INDEX "OfferSnapshot_platformItemId_skuId_capturedAt_idx" ON "OfferSnapshot"("platformItemId", "skuId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceAlert_dedupKey_key" ON "PriceAlert"("dedupKey");

-- CreateIndex
CREATE INDEX "PriceAlert_status_createdAt_idx" ON "PriceAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PriceAlert_monitoredModelId_lastSeenAt_idx" ON "PriceAlert"("monitoredModelId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "AlertAction_alertId_createdAt_idx" ON "AlertAction"("alertId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "MonitoredModel" ADD CONSTRAINT "MonitoredModel_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelAlias" ADD CONSTRAINT "ModelAlias_monitoredModelId_fkey" FOREIGN KEY ("monitoredModelId") REFERENCES "MonitoredModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleItem" ADD CONSTRAINT "BundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnListing" ADD CONSTRAINT "OwnListing_monitoredModelId_fkey" FOREIGN KEY ("monitoredModelId") REFERENCES "MonitoredModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchCandidate" ADD CONSTRAINT "SearchCandidate_monitoredModelId_fkey" FOREIGN KEY ("monitoredModelId") REFERENCES "MonitoredModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRun" ADD CONSTRAINT "CollectionRun_monitoredModelId_fkey" FOREIGN KEY ("monitoredModelId") REFERENCES "MonitoredModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSnapshot" ADD CONSTRAINT "OfferSnapshot_collectionRunId_fkey" FOREIGN KEY ("collectionRunId") REFERENCES "CollectionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSnapshot" ADD CONSTRAINT "OfferSnapshot_ownListingId_fkey" FOREIGN KEY ("ownListingId") REFERENCES "OwnListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSnapshot" ADD CONSTRAINT "OfferSnapshot_searchCandidateId_fkey" FOREIGN KEY ("searchCandidateId") REFERENCES "SearchCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_monitoredModelId_fkey" FOREIGN KEY ("monitoredModelId") REFERENCES "MonitoredModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_ownSnapshotId_fkey" FOREIGN KEY ("ownSnapshotId") REFERENCES "OfferSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_competitorSnapshotId_fkey" FOREIGN KEY ("competitorSnapshotId") REFERENCES "OfferSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "PriceAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
