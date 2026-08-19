import type { AlertActionInput } from "./alert-action.dto.ts";
import {
  AlertActionConflictError,
  AlertActionNotFoundError,
  AlertActionService,
  AlertActionValidationError
} from "./alert-action.service.ts";

export class AlertController {
  private readonly service: AlertActionService;

  constructor(service: AlertActionService) {
    this.service = service;
  }

  async getAlerts() {
    return { status: 200, body: await this.service.listAlerts() };
  }

  async getAlert(id: string) {
    return this.respond(() => this.service.getAlert(id));
  }

  async getActions(id: string) {
    return this.respond(() => this.service.listActions(id));
  }

  async postAction(id: string, input: AlertActionInput, actorId: string) {
    return this.respond(() => this.service.applyAction(id, input, actorId));
  }

  private async respond<T>(operation: () => Promise<T>) {
    try {
      return { status: 200, body: await operation() };
    } catch (error) {
      if (error instanceof AlertActionValidationError) {
        return { status: 400, body: { error: error.message } };
      }
      if (error instanceof AlertActionNotFoundError) {
        return { status: 404, body: { error: error.message } };
      }
      if (error instanceof AlertActionConflictError) {
        return { status: 409, body: { error: error.message } };
      }
      throw error;
    }
  }
}
