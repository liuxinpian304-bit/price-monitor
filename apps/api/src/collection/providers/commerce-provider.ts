export type StockState = "IN_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";

export interface SearchHit {
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  displayPriceRangeFen: { minFen: number; maxFen: number } | null;
}

export interface RawSkuOption {
  skuId: string;
  label: string;
  attributes: Record<string, string>;
  listPriceFen: number;
  publicDiscountFen: number;
  payableFen: number;
  stockState: StockState;
}

export interface RawPromotion {
  type: string;
  label: string;
  amountFen: number | null;
}

export interface RawGift {
  name: string;
  quantity: number;
}

export interface RawOffer {
  platformItemId: string;
  url: string;
  shopName: string;
  title: string;
  selectedSkuId: string;
  skuOptions: RawSkuOption[];
  listPriceFen: number;
  publicDiscountFen: number;
  payableFen: number;
  promotions: RawPromotion[];
  gifts: RawGift[];
  stockState: StockState;
  capturedAt: Date;
  evidenceUrl: string | null;
  rawEvidence: unknown;
}

export interface CommerceProvider {
  search(query: string): Promise<SearchHit[]>;
  fetchOffer(url: string): Promise<RawOffer>;
}

export class ProviderRateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ProviderRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderContractChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderContractChangedError";
  }
}

export class OfferUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferUnavailableError";
  }
}
