import type { CreateCatalogModelInput, UpdateCatalogModelInput } from "./catalog.dto.ts";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  CatalogService,
  CatalogValidationError
} from "./catalog.service.ts";

export interface ApiResponse<T> {
  status: number;
  body: T;
}

export class CatalogController {
  private readonly service: CatalogService;

  constructor(service: CatalogService) {
    this.service = service;
  }

  async getModels() {
    return { status: 200, body: await this.service.listModels() };
  }

  async postModel(input: CreateCatalogModelInput, actorId: string) {
    return this.respond(() => this.service.createModel(input, actorId), 201);
  }

  async patchModel(id: string, input: UpdateCatalogModelInput, actorId: string) {
    return this.respond(() => this.service.updateModel(id, input, actorId), 200);
  }

  async toggleModel(id: string, actorId: string) {
    return this.respond(() => this.service.toggleModel(id, actorId), 200);
  }

  async getBundles(id: string) {
    return this.respond(() => this.service.listBundles(id), 200);
  }

  async getAliases(id: string) {
    return this.respond(() => this.service.listAliases(id), 200);
  }

  private async respond<T>(operation: () => Promise<T>, successStatus: number): Promise<ApiResponse<T | { error: string }>> {
    try {
      return { status: successStatus, body: await operation() };
    } catch (error) {
      if (error instanceof CatalogValidationError) {
        return { status: 400, body: { error: error.message } };
      }
      if (error instanceof CatalogNotFoundError) {
        return { status: 404, body: { error: error.message } };
      }
      if (error instanceof CatalogConflictError) {
        return { status: 409, body: { error: error.message } };
      }
      throw error;
    }
  }
}
