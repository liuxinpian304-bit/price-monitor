import type { CommerceProvider, RawOffer, SearchHit } from "../commerce-provider.ts";
import { mapExternalOffer, mapExternalSearch } from "./external-commerce.mapper.ts";

export interface ExternalCommerceTransport {
  search(query: string): Promise<unknown>;
  fetchOffer(url: string): Promise<unknown>;
}

export class ExternalCommerceProvider implements CommerceProvider {
  private readonly transport: ExternalCommerceTransport;

  constructor(transport: ExternalCommerceTransport) {
    this.transport = transport;
  }

  async search(query: string): Promise<SearchHit[]> {
    return mapExternalSearch(await this.transport.search(query));
  }

  async fetchOffer(url: string): Promise<RawOffer> {
    return mapExternalOffer(await this.transport.fetchOffer(url));
  }
}
