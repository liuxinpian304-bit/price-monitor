export interface OwnCatalogListingFact {
  id: string;
  platformItemId: string | null;
}

export interface OwnCatalogSnapshotFact {
  ownListingId: string | null;
  platformItemId: string;
  skuId: string | null;
}

export interface OwnCatalogIssueFact {
  code: string;
  platformItemId: string | null;
  skuId: string | null;
}

export interface OwnCatalogCompletenessInput {
  claimedOwnListings: OwnCatalogListingFact[];
  ownSnapshots: OwnCatalogSnapshotFact[];
  issues: OwnCatalogIssueFact[];
}

export interface OwnCatalogCompleteness {
  complete: boolean;
  configuredListingCount: number;
  collectedListingCount: number;
}

const OWN_ITEM_DETAIL_FAILURES = new Set([
  "ITEM_UNAVAILABLE",
  "SKU_ENUMERATION_INCOMPLETE",
  "SKU_SELECTION_MISMATCH",
  "PRICE_UNSTABLE"
]);
const UNATTRIBUTED_COLLECTION_FAILURES = new Set([
  "MISSING_ITEM_ID",
  "UI_CONTRACT_CHANGED"
]);

export function deriveOwnCatalogCompleteness(
  input: OwnCatalogCompletenessInput
): OwnCatalogCompleteness {
  const claimedListingIds = new Set(input.claimedOwnListings.map((listing) => listing.id));
  const collectedListingIds = new Set(input.ownSnapshots.flatMap((snapshot) =>
    snapshot.ownListingId !== null && claimedListingIds.has(snapshot.ownListingId)
      ? [snapshot.ownListingId]
      : []));
  const ownPlatformItemIds = new Set([
    ...input.claimedOwnListings.flatMap((listing) => listing.platformItemId ? [listing.platformItemId] : []),
    ...input.ownSnapshots.flatMap((snapshot) =>
      snapshot.ownListingId !== null && claimedListingIds.has(snapshot.ownListingId)
        ? [snapshot.platformItemId]
        : [])
  ]);
  const ownSkuIds = new Set(input.ownSnapshots.flatMap((snapshot) =>
    snapshot.ownListingId !== null
      && claimedListingIds.has(snapshot.ownListingId)
      && snapshot.skuId !== null
      ? [snapshot.skuId]
      : []));
  const hasBlockingIssue = input.issues.some((issue) =>
    UNATTRIBUTED_COLLECTION_FAILURES.has(issue.code)
    || (OWN_ITEM_DETAIL_FAILURES.has(issue.code)
      && ((issue.platformItemId !== null && ownPlatformItemIds.has(issue.platformItemId))
        || (issue.platformItemId === null && issue.skuId !== null && ownSkuIds.has(issue.skuId)))));

  return {
    complete: claimedListingIds.size > 0
      && [...claimedListingIds].every((id) => collectedListingIds.has(id))
      && !hasBlockingIssue,
    configuredListingCount: claimedListingIds.size,
    collectedListingCount: collectedListingIds.size
  };
}
