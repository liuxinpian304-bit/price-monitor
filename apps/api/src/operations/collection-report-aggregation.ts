export type CollectionRunCombinationState = "OWN" | "MATCHED" | "MISSING_OWN" | "REVIEW" | "EXCLUDED";
export type CollectionRunBusinessSource = "OWN" | "COMPETITOR";
export type CollectionRunBusinessMatch = "EXACT" | "REVIEW" | "EXCLUDED";
export type CollectionRunBusinessConfidence = "CONFIRMED" | "ESTIMATED" | "MANUAL_REVIEW";

export interface CollectionRunSkuComponent {
  role: "CORE" | "PAID_ACCESSORY" | "GIFT_OR_SERVICE" | "UNKNOWN";
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
}

export interface CollectionRunPromotion {
  kind: string;
  label: string;
  amountFen: number | null;
  thresholdFen: number | null;
  audience: string;
  stackGroup: string | null;
  includedInActivityPrice: boolean;
  activityPriceInclusion: "INCLUDED" | "EXCLUDED" | "UNKNOWN";
}

export interface CollectionRunGift {
  name: string;
  quantity: number;
}

export interface CollectionRunBusinessPositionFact {
  rank: number;
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinFen: number;
  displayPriceMaxFen: number;
  sponsored: boolean;
  capturedAt: Date;
}

export interface CollectionRunBusinessSnapshotFact {
  id: string;
  ownListingId: string | null;
  platformItemId: string;
  skuId: string | null;
  shopName: string;
  title: string;
  skuText: string | null;
  url: string;
  attributes: Record<string, string>;
  components: CollectionRunSkuComponent[] | null;
  promotions: CollectionRunPromotion[];
  gifts: CollectionRunGift[];
  listPriceFen: number | null;
  activityPriceFen: number | null;
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  mandatoryFeeFen: number;
  publicDiscountFen: number;
  payableFen: number | null;
  priceConfidence: CollectionRunBusinessConfidence;
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  matchCategory: CollectionRunBusinessMatch;
  matchDecision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | null;
  comparable: boolean;
  matchConfidenceBps: number;
  matchReasons: string[];
  combinationSignature: string | null;
  combinationLabel: string | null;
  combinationState: CollectionRunCombinationState | null;
  combinationReasons: string[];
  comparisonOwnSnapshotId: string | null;
  evidenceKey: string | null;
  capturedAt: Date;
}

export interface CollectionRunBusinessAggregationInput {
  claimedOwnListingIds: string[];
  positions: CollectionRunBusinessPositionFact[];
  snapshots: CollectionRunBusinessSnapshotFact[];
}

export interface CollectionRunBusinessPosition {
  rank: number;
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinFen: number;
  displayPriceMaxFen: number;
  sponsored: boolean;
  capturedAt: string;
}

export interface CollectionRunBusinessPrices {
  listPriceFen: number | null;
  activityPriceFen: number | null;
  couponDiscountFen: number;
  fullReductionFen: number;
  directDiscountFen: number;
  mandatoryFeeFen: number;
  publicDiscountFen: number;
  payableFen: number | null;
}

export interface CollectionRunOwnSnapshotSummary {
  id: string;
  ownListingId: string;
  platformItemId: string;
  skuId: string | null;
  shopName: string;
  title: string;
  skuText: string | null;
  url: string;
  attributes: Record<string, string>;
  components: CollectionRunSkuComponent[] | null;
  promotions: CollectionRunPromotion[];
  gifts: CollectionRunGift[];
  prices: CollectionRunBusinessPrices;
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  confidence: CollectionRunBusinessConfidence;
  combinationSignature: string | null;
  combinationLabel: string | null;
}

export interface CollectionRunBusinessSkuRow {
  id: string;
  source: CollectionRunBusinessSource;
  platformItemId: string;
  skuId: string | null;
  shopName: string;
  title: string;
  skuText: string | null;
  url: string;
  ranks: number[];
  positions: CollectionRunBusinessPosition[];
  attributes: Record<string, string>;
  components: CollectionRunSkuComponent[] | null;
  promotions: CollectionRunPromotion[];
  gifts: CollectionRunGift[];
  prices: CollectionRunBusinessPrices;
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  confidence: CollectionRunBusinessConfidence;
  match: {
    category: CollectionRunBusinessMatch;
    decision: "PENDING" | "BARE" | "BUNDLE" | "REJECTED" | "MANUAL" | null;
    comparable: boolean;
    confidenceBps: number;
    reasons: string[];
  };
  combination: {
    state: CollectionRunCombinationState;
    signature: string | null;
    label: string | null;
    reasons: string[];
  };
  selectedOwnSnapshot: CollectionRunOwnSnapshotSummary | null;
  alternativeOwnSnapshots: CollectionRunOwnSnapshotSummary[];
  differenceFen: number | null;
  comparison: {
    state: "OWN" | "LOWER" | "NOT_LOWER" | "UNDECIDED";
    ownPayableFen: number | null;
    differenceFen: number | null;
  };
  evidenceSha256: string | null;
  capturedAt: string;
}

export interface CollectionRunBusinessItemGroup {
  platformItemId: string;
  shopName: string;
  title: string;
  url: string;
  earliestRank: number;
  ranks: number[];
  positions: CollectionRunBusinessPosition[];
  skuCount: number;
  skus: CollectionRunBusinessSkuRow[];
}

export interface CollectionRunShopGroup {
  shopName: string;
  earliestRank: number;
  ranks: number[];
  positionCount: number;
  itemCount: number;
  skuCount: number;
  minimumConfirmedPayableFen: number | null;
  confirmedLowCount: number;
  missingCombinationCount: number;
  items: CollectionRunBusinessItemGroup[];
}

export interface CollectionRunConfirmedLow {
  competitorSnapshot: CollectionRunBusinessSkuRow;
  selectedOwnSnapshot: CollectionRunOwnSnapshotSummary;
  alternativeOwnSnapshots: CollectionRunOwnSnapshotSummary[];
  combinationSignature: string | null;
  combinationLabel: string | null;
  differenceFen: number;
  ranks: number[];
  reasons: string[];
}

export interface CollectionRunMissingOwnGroup {
  combinationSignature: string;
  combinationLabel: string;
  missingReason: "OWN_COMBINATION_ABSENT" | "OWN_OUT_OF_STOCK_ONLY";
  earliestRank: number;
  minimumConfirmedPayableFen: number | null;
  minimumOfferSnapshotId: string | null;
  minimumOfferRank: number | null;
  shops: string[];
  offers: CollectionRunBusinessSkuRow[];
}

export interface CollectionRunBusinessSummary {
  distinctShopCount: number;
  distinctItemCount: number;
  skuCount: number;
  matchedSkuCount: number;
  confirmedLowCount: number;
  missingCombinationCount: number;
  reviewCount: number;
  excludedCount: number;
  ownConfiguredListingCount: number;
  ownCollectedListingCount: number;
  ownCatalogComplete: boolean;
}

export interface CollectionRunBusinessSections {
  businessSummary: CollectionRunBusinessSummary;
  priceBoard: { shops: CollectionRunShopGroup[] };
  confirmedLows: CollectionRunConfirmedLow[];
  missingOwnGroups: CollectionRunMissingOwnGroup[];
  reviewRows: CollectionRunBusinessSkuRow[];
}

const evidenceKeyPattern = /^sha256:([0-9a-f]{64})$/;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function nonNegativeFen(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function confirmedInStockPrice(
  confidence: CollectionRunBusinessConfidence,
  stockState: "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN",
  payableFen: number | null
): payableFen is number {
  return confidence === "CONFIRMED" && stockState === "IN_STOCK" && nonNegativeFen(payableFen);
}

function displayShopName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizedShopName(value: string): string {
  return displayShopName(value).normalize("NFKC").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function prices(snapshot: CollectionRunBusinessSnapshotFact): CollectionRunBusinessPrices {
  return {
    listPriceFen: snapshot.listPriceFen,
    activityPriceFen: snapshot.activityPriceFen,
    couponDiscountFen: snapshot.couponDiscountFen,
    fullReductionFen: snapshot.fullReductionFen,
    directDiscountFen: snapshot.directDiscountFen,
    mandatoryFeeFen: snapshot.mandatoryFeeFen,
    publicDiscountFen: snapshot.publicDiscountFen,
    payableFen: snapshot.payableFen
  };
}

function cloneAttributes(attributes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => compareText(left, right)));
}

function cloneComponents(components: CollectionRunSkuComponent[] | null): CollectionRunSkuComponent[] | null {
  return components?.map((component) => ({ ...component })) ?? null;
}

function clonePromotions(promotions: CollectionRunPromotion[]): CollectionRunPromotion[] {
  return promotions.map((promotion) => ({ ...promotion }));
}

function cloneGifts(gifts: CollectionRunGift[]): CollectionRunGift[] {
  return gifts.map((gift) => ({ ...gift }));
}

function ownSummary(snapshot: CollectionRunBusinessSnapshotFact): CollectionRunOwnSnapshotSummary | null {
  if (!snapshot.ownListingId) return null;
  return {
    id: snapshot.id,
    ownListingId: snapshot.ownListingId,
    platformItemId: snapshot.platformItemId,
    skuId: snapshot.skuId,
    shopName: snapshot.shopName,
    title: snapshot.title,
    skuText: snapshot.skuText,
    url: snapshot.url,
    attributes: cloneAttributes(snapshot.attributes),
    components: cloneComponents(snapshot.components),
    promotions: clonePromotions(snapshot.promotions),
    gifts: cloneGifts(snapshot.gifts),
    prices: prices(snapshot),
    stockState: snapshot.stockState,
    confidence: snapshot.priceConfidence,
    combinationSignature: snapshot.combinationSignature,
    combinationLabel: snapshot.combinationLabel
  };
}

function compareOwn(left: CollectionRunOwnSnapshotSummary, right: CollectionRunOwnSnapshotSummary): number {
  const leftPayable = left.confidence === "CONFIRMED" && left.prices.payableFen !== null
    ? left.prices.payableFen
    : Number.MAX_SAFE_INTEGER;
  const rightPayable = right.confidence === "CONFIRMED" && right.prices.payableFen !== null
    ? right.prices.payableFen
    : Number.MAX_SAFE_INTEGER;
  return compareNumber(leftPayable, rightPayable)
    || compareText(left.platformItemId, right.platformItemId)
    || compareText(left.skuId ?? "", right.skuId ?? "")
    || compareText(left.id, right.id);
}

function positionOutput(position: CollectionRunBusinessPositionFact): CollectionRunBusinessPosition {
  return { ...position, capturedAt: position.capturedAt.toISOString() };
}

function comparePosition(
  left: CollectionRunBusinessPositionFact,
  right: CollectionRunBusinessPositionFact
): number {
  return compareNumber(left.rank, right.rank)
    || compareText(left.platformItemId, right.platformItemId)
    || compareText(left.url, right.url)
    || compareText(left.capturedAt.toISOString(), right.capturedAt.toISOString());
}

function compareRow(left: CollectionRunBusinessSkuRow, right: CollectionRunBusinessSkuRow): number {
  const leftRank = left.ranks[0] ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.ranks[0] ?? Number.MAX_SAFE_INTEGER;
  return compareNumber(leftRank, rightRank)
    || compareText(left.platformItemId, right.platformItemId)
    || compareText(left.skuId ?? "", right.skuId ?? "")
    || compareText(left.id, right.id);
}

function projectedRows(input: CollectionRunBusinessAggregationInput): CollectionRunBusinessSkuRow[] {
  const positionsByItem = new Map<string, CollectionRunBusinessPositionFact[]>();
  for (const position of [...input.positions].sort(comparePosition)) {
    const rows = positionsByItem.get(position.platformItemId) ?? [];
    rows.push(position);
    positionsByItem.set(position.platformItemId, rows);
  }

  const ownById = new Map<string, CollectionRunOwnSnapshotSummary>();
  const ownBySignature = new Map<string, CollectionRunOwnSnapshotSummary[]>();
  for (const snapshot of input.snapshots) {
    const summary = ownSummary(snapshot);
    if (!summary) continue;
    ownById.set(summary.id, summary);
    if (!summary.combinationSignature) continue;
    const rows = ownBySignature.get(summary.combinationSignature) ?? [];
    rows.push(summary);
    ownBySignature.set(summary.combinationSignature, rows);
  }
  for (const rows of ownBySignature.values()) rows.sort(compareOwn);

  return input.snapshots.map((snapshot): CollectionRunBusinessSkuRow => {
    const legacy = snapshot.combinationState === null;
    const selectedCandidate = snapshot.comparisonOwnSnapshotId
      ? ownById.get(snapshot.comparisonOwnSnapshotId) ?? null
      : null;
    const validComparisonOwnRelation = selectedCandidate !== null
      && snapshot.combinationSignature !== null
      && selectedCandidate.combinationSignature !== null
      && selectedCandidate.combinationSignature === snapshot.combinationSignature;
    const invalidMatchedRelation = snapshot.combinationState === "MATCHED" && !validComparisonOwnRelation;
    const persistedCombinationState = snapshot.combinationState ?? "REVIEW";
    const combinationState: CollectionRunCombinationState = legacy || invalidMatchedRelation
      ? "REVIEW"
      : persistedCombinationState;
    const combinationReasons = uniqueStrings([
      ...snapshot.combinationReasons,
      ...(legacy ? ["LEGACY_COMBINATION_NOT_EVALUATED"] : []),
      ...(invalidMatchedRelation ? ["INVALID_COMPARISON_OWN_SNAPSHOT"] : [])
    ]);
    const selectedOwnSnapshot = validComparisonOwnRelation
      ? { ...selectedCandidate }
      : null;
    const alternativeOwnSnapshots = snapshot.combinationSignature
      ? (ownBySignature.get(snapshot.combinationSignature) ?? [])
        .filter((row) => row.id !== selectedOwnSnapshot?.id)
        .map((row) => ({ ...row }))
      : [];
    const differenceFen = selectedOwnSnapshot
      && nonNegativeFen(selectedOwnSnapshot.prices.payableFen)
      && nonNegativeFen(snapshot.payableFen)
      ? selectedOwnSnapshot.prices.payableFen - snapshot.payableFen
      : null;
    const source: CollectionRunBusinessSource = snapshot.ownListingId ? "OWN" : "COMPETITOR";
    const eligibleComparison = source === "COMPETITOR"
      && combinationState === "MATCHED"
      && selectedOwnSnapshot !== null
      && confirmedInStockPrice(snapshot.priceConfidence, snapshot.stockState, snapshot.payableFen)
      && confirmedInStockPrice(
        selectedOwnSnapshot.confidence,
        selectedOwnSnapshot.stockState,
        selectedOwnSnapshot.prices.payableFen
      );
    const comparisonState = source === "OWN"
      ? "OWN"
      : eligibleComparison && differenceFen !== null
        ? differenceFen > 0 ? "LOWER" : "NOT_LOWER"
        : "UNDECIDED";
    const itemPositions = positionsByItem.get(snapshot.platformItemId) ?? [];
    return {
      id: snapshot.id,
      source,
      platformItemId: snapshot.platformItemId,
      skuId: snapshot.skuId,
      shopName: snapshot.shopName,
      title: snapshot.title,
      skuText: snapshot.skuText,
      url: snapshot.url || itemPositions[0]?.url || "",
      ranks: itemPositions.map((position) => position.rank),
      positions: itemPositions.map(positionOutput),
      attributes: cloneAttributes(snapshot.attributes),
      components: cloneComponents(snapshot.components),
      promotions: clonePromotions(snapshot.promotions),
      gifts: cloneGifts(snapshot.gifts),
      prices: prices(snapshot),
      stockState: snapshot.stockState,
      confidence: snapshot.priceConfidence,
      match: {
        category: snapshot.matchCategory,
        decision: snapshot.matchDecision,
        comparable: snapshot.comparable,
        confidenceBps: snapshot.matchConfidenceBps,
        reasons: [...snapshot.matchReasons]
      },
      combination: {
        state: combinationState,
        signature: snapshot.combinationSignature,
        label: snapshot.combinationLabel,
        reasons: combinationReasons
      },
      selectedOwnSnapshot,
      alternativeOwnSnapshots,
      differenceFen,
      comparison: {
        state: comparisonState,
        ownPayableFen: selectedOwnSnapshot?.prices.payableFen ?? null,
        differenceFen: differenceFen === null ? null : Math.abs(differenceFen)
      },
      evidenceSha256: evidenceKeyPattern.exec(snapshot.evidenceKey ?? "")?.[1] ?? null,
      capturedAt: snapshot.capturedAt.toISOString()
    };
  }).sort(compareRow);
}

export function projectCollectionRunBusinessSkuRows(
  input: CollectionRunBusinessAggregationInput
): CollectionRunBusinessSkuRow[] {
  return projectedRows(input);
}

function confirmedLows(rows: CollectionRunBusinessSkuRow[]): CollectionRunConfirmedLow[] {
  return rows.flatMap((row): CollectionRunConfirmedLow[] => {
    if (
      row.source !== "COMPETITOR"
      || row.combination.state !== "MATCHED"
      || row.combination.signature === null
      || !row.selectedOwnSnapshot
      || row.selectedOwnSnapshot.combinationSignature !== row.combination.signature
      || !confirmedInStockPrice(row.confidence, row.stockState, row.prices.payableFen)
      || !confirmedInStockPrice(
        row.selectedOwnSnapshot.confidence,
        row.selectedOwnSnapshot.stockState,
        row.selectedOwnSnapshot.prices.payableFen
      )
      || row.differenceFen === null
      || row.differenceFen <= 0
    ) return [];
    return [{
      competitorSnapshot: row,
      selectedOwnSnapshot: row.selectedOwnSnapshot,
      alternativeOwnSnapshots: row.alternativeOwnSnapshots,
      combinationSignature: row.combination.signature,
      combinationLabel: row.combination.label,
      differenceFen: row.differenceFen,
      ranks: [...row.ranks],
      reasons: [...row.combination.reasons]
    }];
  }).sort((left, right) =>
    compareNumber(right.differenceFen, left.differenceFen)
      || compareNumber(left.ranks[0] ?? Number.MAX_SAFE_INTEGER, right.ranks[0] ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.competitorSnapshot.platformItemId, right.competitorSnapshot.platformItemId)
      || compareText(left.competitorSnapshot.skuId ?? "", right.competitorSnapshot.skuId ?? "")
      || compareText(left.competitorSnapshot.id, right.competitorSnapshot.id)
  );
}

function missingGroups(rows: CollectionRunBusinessSkuRow[]): CollectionRunMissingOwnGroup[] {
  const bySignature = new Map<string, CollectionRunBusinessSkuRow[]>();
  for (const row of rows) {
    if (row.combination.state !== "MISSING_OWN" || !row.combination.signature) continue;
    const entries = bySignature.get(row.combination.signature) ?? [];
    entries.push(row);
    bySignature.set(row.combination.signature, entries);
  }

  return [...bySignature.entries()].flatMap(([signature, entries]): CollectionRunMissingOwnGroup[] => {
    const offers = [...entries].sort(compareRow);
    const minimumOffer = offers.filter((row) =>
      confirmedInStockPrice(row.confidence, row.stockState, row.prices.payableFen)
    ).sort((left, right) =>
      compareNumber(left.prices.payableFen!, right.prices.payableFen!) || compareRow(left, right)
    )[0] ?? null;
    const ranks = offers.flatMap((row) => row.ranks);
    const shops = new Map<string, { name: string; rank: number }>();
    for (const row of offers) {
      const key = normalizedShopName(row.shopName);
      const rank = row.ranks[0] ?? Number.MAX_SAFE_INTEGER;
      const existing = shops.get(key);
      if (!existing || rank < existing.rank) shops.set(key, { name: displayShopName(row.shopName), rank });
    }
    const missingReason = offers.some((row) => row.combination.reasons.includes("OWN_OUT_OF_STOCK_ONLY"))
      ? "OWN_OUT_OF_STOCK_ONLY"
      : "OWN_COMBINATION_ABSENT";
    return [{
      combinationSignature: signature,
      combinationLabel: offers.map((row) => row.combination.label ?? "").sort(compareText)[0] ?? "",
      missingReason,
      earliestRank: Math.min(...ranks),
      minimumConfirmedPayableFen: minimumOffer?.prices.payableFen ?? null,
      minimumOfferSnapshotId: minimumOffer?.id ?? null,
      minimumOfferRank: minimumOffer?.ranks[0] ?? null,
      shops: [...shops.entries()]
        .sort(([leftKey, left], [rightKey, right]) =>
          compareNumber(left.rank, right.rank) || compareText(leftKey, rightKey))
        .map(([, shop]) => shop.name),
      offers
    }];
  }).sort((left, right) => {
    const priceOrder = left.minimumConfirmedPayableFen === null
      ? right.minimumConfirmedPayableFen === null ? 0 : 1
      : right.minimumConfirmedPayableFen === null
        ? -1
        : compareNumber(left.minimumConfirmedPayableFen, right.minimumConfirmedPayableFen);
    return priceOrder
      || compareNumber(left.earliestRank, right.earliestRank)
      || compareText(left.combinationSignature, right.combinationSignature);
  });
}

function priceBoard(
  positions: CollectionRunBusinessPositionFact[],
  rows: CollectionRunBusinessSkuRow[]
): { shops: CollectionRunShopGroup[] } {
  const rowsByItem = new Map<string, CollectionRunBusinessSkuRow[]>();
  for (const row of rows) {
    const itemRows = rowsByItem.get(row.platformItemId) ?? [];
    itemRows.push(row);
    rowsByItem.set(row.platformItemId, itemRows);
  }

  const positionsByItem = new Map<string, CollectionRunBusinessPositionFact[]>();
  for (const position of [...positions].sort(comparePosition)) {
    const itemPositions = positionsByItem.get(position.platformItemId) ?? [];
    itemPositions.push(position);
    positionsByItem.set(position.platformItemId, itemPositions);
  }

  const shops = new Map<string, { shopName: string; items: CollectionRunBusinessItemGroup[] }>();
  for (const [platformItemId, itemPositionFacts] of positionsByItem) {
    const first = itemPositionFacts[0]!;
    const key = normalizedShopName(first.shopName);
    const shop = shops.get(key) ?? { shopName: displayShopName(first.shopName), items: [] };
    const itemRows = [...(rowsByItem.get(platformItemId) ?? [])].sort(compareRow);
    shop.items.push({
      platformItemId,
      shopName: shop.shopName,
      title: first.title,
      url: first.url,
      earliestRank: first.rank,
      ranks: itemPositionFacts.map((position) => position.rank),
      positions: itemPositionFacts.map(positionOutput),
      skuCount: itemRows.length,
      skus: itemRows
    });
    shops.set(key, shop);
  }

  return {
    shops: [...shops.entries()].map(([key, group]): [string, CollectionRunShopGroup] => {
      const items = [...group.items].sort((left, right) =>
        compareNumber(left.earliestRank, right.earliestRank)
          || compareText(left.platformItemId, right.platformItemId));
      const skus = items.flatMap((item) => item.skus);
      const ranks = items.flatMap((item) => item.ranks).sort(compareNumber);
      const confirmedPrices = skus.flatMap((row) =>
        row.confidence === "CONFIRMED" && row.prices.payableFen !== null ? [row.prices.payableFen] : []);
      const missingSignatures = new Set(skus.flatMap((row) =>
        row.combination.state === "MISSING_OWN" && row.combination.signature
          ? [row.combination.signature]
          : []));
      return [key, {
        shopName: group.shopName,
        earliestRank: ranks[0]!,
        ranks,
        positionCount: ranks.length,
        itemCount: items.length,
        skuCount: skus.length,
        minimumConfirmedPayableFen: confirmedPrices.length > 0 ? Math.min(...confirmedPrices) : null,
        confirmedLowCount: confirmedLows(skus).length,
        missingCombinationCount: missingSignatures.size,
        items
      }];
    }).sort(([leftKey, left], [rightKey, right]) =>
      compareNumber(left.earliestRank, right.earliestRank) || compareText(leftKey, rightKey))
      .map(([, shop]) => shop)
  };
}

export function aggregateCollectionRunReport(
  input: CollectionRunBusinessAggregationInput
): CollectionRunBusinessSections {
  const allRows = projectedRows(input);
  const businessRows = allRows.filter((row) => row.source === "COMPETITOR" && row.ranks.length > 0);
  const lows = confirmedLows(businessRows);
  const missing = missingGroups(businessRows);
  const board = priceBoard(input.positions, businessRows);
  const claimedOwnListingIds = new Set(input.claimedOwnListingIds);
  const collectedOwnListingIds = new Set(input.snapshots.flatMap((snapshot) =>
    snapshot.ownListingId ? [snapshot.ownListingId] : []));
  return {
    businessSummary: {
      distinctShopCount: board.shops.length,
      distinctItemCount: new Set(input.positions.map((position) => position.platformItemId)).size,
      skuCount: businessRows.length,
      matchedSkuCount: businessRows.filter((row) => row.combination.state === "MATCHED").length,
      confirmedLowCount: lows.length,
      missingCombinationCount: missing.length,
      reviewCount: businessRows.filter((row) => row.combination.state === "REVIEW").length,
      excludedCount: businessRows.filter((row) => row.combination.state === "EXCLUDED").length,
      ownConfiguredListingCount: claimedOwnListingIds.size,
      ownCollectedListingCount: collectedOwnListingIds.size,
      ownCatalogComplete: claimedOwnListingIds.size > 0
        && [...claimedOwnListingIds].every((id) => collectedOwnListingIds.has(id))
    },
    priceBoard: board,
    confirmedLows: lows,
    missingOwnGroups: missing,
    reviewRows: businessRows.filter((row) => row.combination.state === "REVIEW").sort(compareRow)
  };
}
