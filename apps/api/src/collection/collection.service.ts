import type { MatchDecision, MonitoredProductRule } from "../matching/matcher.types.ts";
import { MatcherService } from "../matching/matcher.service.ts";
import type { PriceResult } from "../pricing/price-engine.service.ts";
import { PriceEngineService } from "../pricing/price-engine.service.ts";
import {
  OfferUnavailableError,
  ProviderContractChangedError,
  ProviderRateLimitedError,
  type CommerceProvider,
  type RawOffer,
  type SearchHit
} from "./providers/commerce-provider.ts";

export interface CollectionSummary {
  searched: number;
  fetched: number;
  matched: number;
  failed: number;
}

export interface CollectionModel {
  id: string;
  providerKey: string;
  searchQuery: string;
  rule: MonitoredProductRule;
}

export interface CollectedOfferInput {
  runId: string;
  model: CollectionModel;
  hit: SearchHit;
  offer: RawOffer;
  match: MatchDecision;
  price: PriceResult;
}

export interface CollectionRepository {
  getModel(id: string): Promise<CollectionModel | null>;
  getCompletedSummary(runId: string): Promise<CollectionSummary | null>;
  startRun(runId: string, model: CollectionModel): Promise<void>;
  saveOffer(input: CollectedOfferInput): Promise<void>;
  recordItemFailure(runId: string, url: string, message: string): Promise<void>;
  recordSystemError(runId: string, code: string, message: string): Promise<void>;
  finishRun(
    runId: string,
    status: "SUCCEEDED" | "PARTIAL_FAILED" | "FAILED",
    summary: CollectionSummary
  ): Promise<void>;
}

export interface CollectionLock {
  acquire(key: string, ttlMilliseconds: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

export class CollectionAlreadyRunningError extends Error {}
export class CollectionModelNotFoundError extends Error {}

function providerErrorCode(error: unknown): string {
  if (error instanceof ProviderRateLimitedError) return "PROVIDER_RATE_LIMITED";
  if (error instanceof ProviderContractChangedError) return "PROVIDER_CONTRACT_CHANGED";
  return "PROVIDER_UNAVAILABLE";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSystemProviderError(error: unknown): boolean {
  return error instanceof ProviderRateLimitedError || error instanceof ProviderContractChangedError;
}

export class CollectionService {
  private readonly repository: CollectionRepository;
  private readonly provider: CommerceProvider;
  private readonly matcher: MatcherService;
  private readonly priceEngine: PriceEngineService;
  private readonly lock: CollectionLock;

  constructor(
    repository: CollectionRepository,
    provider: CommerceProvider,
    matcher: MatcherService,
    priceEngine: PriceEngineService,
    lock: CollectionLock
  ) {
    this.repository = repository;
    this.provider = provider;
    this.matcher = matcher;
    this.priceEngine = priceEngine;
    this.lock = lock;
  }

  async runMonitoredModel(monitoredModelId: string, runId: string): Promise<CollectionSummary> {
    const completed = await this.repository.getCompletedSummary(runId);
    if (completed) {
      return completed;
    }

    const model = await this.repository.getModel(monitoredModelId);
    if (!model) {
      throw new CollectionModelNotFoundError(`监控型号“${monitoredModelId}”不存在`);
    }

    const lockKey = `collection:model:${monitoredModelId}`;
    const lockToken = await this.lock.acquire(lockKey, 15 * 60 * 1000);
    if (!lockToken) {
      throw new CollectionAlreadyRunningError(`监控型号“${monitoredModelId}”正在采集中`);
    }

    const summary: CollectionSummary = { searched: 0, fetched: 0, matched: 0, failed: 0 };
    await this.repository.startRun(runId, model);

    try {
      const hits = await this.provider.search(model.searchQuery);
      summary.searched = hits.length;

      for (const hit of hits) {
        try {
          const offer = await this.provider.fetchOffer(hit.url);
          summary.fetched += 1;
          const match = this.matcher.match(model.rule, offer);
          const price = this.priceEngine.calculate({
            pagePriceFen: offer.listPriceFen,
            publicDiscounts: offer.publicDiscountFen === 0
              ? []
              : [{ label: "供应商确认的公开优惠", amountFen: offer.publicDiscountFen }],
            mandatoryFees: [],
            privatePriceRequired: false
          });

          await this.repository.saveOffer({ runId, model, hit, offer, match, price });
          if (match.comparable) {
            summary.matched += 1;
          }
        } catch (error) {
          if (isSystemProviderError(error)) {
            throw error;
          }

          summary.failed += 1;
          await this.repository.recordItemFailure(runId, hit.url, messageOf(error));
        }
      }

      await this.repository.finishRun(
        runId,
        summary.failed > 0 ? "PARTIAL_FAILED" : "SUCCEEDED",
        summary
      );
      return summary;
    } catch (error) {
      summary.failed += error instanceof OfferUnavailableError ? 1 : 0;
      await this.repository.recordSystemError(runId, providerErrorCode(error), messageOf(error));
      await this.repository.finishRun(runId, "FAILED", summary);
      throw error;
    } finally {
      await this.lock.release(lockKey, lockToken);
    }
  }
}
