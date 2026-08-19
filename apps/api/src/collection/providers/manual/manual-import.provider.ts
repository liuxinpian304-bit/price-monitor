import {
  OfferUnavailableError,
  type CommerceProvider,
  type RawOffer,
  type SearchHit
} from "../commerce-provider.ts";
import { mapExternalOffer, mapExternalSearch } from "../external/external-commerce.mapper.ts";

export interface ManualImportFixtures {
  searchResponse: unknown;
  offersByUrl: Map<string, unknown>;
}

export class ManualImportProvider implements CommerceProvider {
  private readonly fixtures: ManualImportFixtures;

  constructor(fixtures: ManualImportFixtures) {
    this.fixtures = fixtures;
  }

  async search(_query: string): Promise<SearchHit[]> {
    return mapExternalSearch(this.fixtures.searchResponse);
  }

  async fetchOffer(url: string): Promise<RawOffer> {
    const payload = this.fixtures.offersByUrl.get(url);
    if (payload === undefined) {
      throw new OfferUnavailableError(`手工样例中没有商品链接：${url}`);
    }
    return mapExternalOffer(payload);
  }
}
