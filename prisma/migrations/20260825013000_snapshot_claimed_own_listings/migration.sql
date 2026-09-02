ALTER TABLE "CollectionRun"
ADD COLUMN "claimedOwnListingIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
