CREATE TYPE "SkuCombinationState" AS ENUM ('OWN', 'MATCHED', 'MISSING_OWN', 'REVIEW', 'EXCLUDED');

ALTER TABLE "OfferSnapshot"
  ADD COLUMN "combinationSignature" VARCHAR(100),
  ADD COLUMN "combinationLabel" VARCHAR(1000),
  ADD COLUMN "combinationState" "SkuCombinationState",
  ADD COLUMN "combinationReasons" JSONB,
  ADD COLUMN "comparisonOwnSnapshotId" TEXT;

ALTER TABLE "OfferSnapshot"
  ADD CONSTRAINT "OfferSnapshot_comparisonOwnSnapshotId_fkey"
  FOREIGN KEY ("comparisonOwnSnapshotId") REFERENCES "OfferSnapshot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OfferSnapshot_collectionRunId_combinationState_idx"
  ON "OfferSnapshot"("collectionRunId", "combinationState");

CREATE INDEX "OfferSnapshot_collectionRunId_combinationSignature_idx"
  ON "OfferSnapshot"("collectionRunId", "combinationSignature");

CREATE INDEX "OfferSnapshot_collectionRunId_shopName_idx"
  ON "OfferSnapshot"("collectionRunId", "shopName");

CREATE INDEX "OfferSnapshot_comparisonOwnSnapshotId_idx"
  ON "OfferSnapshot"("comparisonOwnSnapshotId");
