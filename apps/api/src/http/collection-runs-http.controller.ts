import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res
} from "@nestjs/common";
import type { Request, Response } from "express";

import { Roles } from "../auth/roles.guard.ts";
import {
  CollectionRunModelNotFoundError,
  CollectionRunNotPausedError
} from "../collection/collection-run-queue.service.ts";
import { requestIdentity } from "./identity.ts";

export interface CollectionRunHttpService {
  enqueueModelNow(
    monitoredModelId: string,
    actorId: string,
    searchLimit?: number
  ): Promise<{ runId: string; coalesced: boolean }>;
  requeuePausedRun(runId: string): Promise<{ runId: string }>;
}

export const COLLECTION_RUN_QUEUE_SERVICE = Symbol("COLLECTION_RUN_QUEUE_SERVICE");

function searchLimitFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 50) {
    throw new BadRequestException("searchLimit 必须是 1 到 50 的整数");
  }
  return value;
}

export class CollectionRunsHttpController {
  private readonly collectionRuns: CollectionRunHttpService;

  constructor(collectionRuns: CollectionRunHttpService) {
    this.collectionRuns = collectionRuns;
  }

  async enqueue(
    body: { monitoredModelId?: unknown; searchLimit?: unknown },
    request: Request,
    response: Response
  ) {
    if (typeof body?.monitoredModelId !== "string" || body.monitoredModelId.trim() === "") {
      throw new BadRequestException("monitoredModelId 无效");
    }
    try {
      const result = await this.collectionRuns.enqueueModelNow(
        body.monitoredModelId,
        requestIdentity(request).actorId,
        searchLimitFrom(body.searchLimit)
      );
      response.status(202);
      return result;
    } catch (error) {
      if (error instanceof CollectionRunModelNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  async requeue(
    runId: string,
    _request: Request,
    response: Response
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new BadRequestException("runId 无效");
    }
    try {
      const result = await this.collectionRuns.requeuePausedRun(runId);
      response.status(202);
      return result;
    } catch (error) {
      if (error instanceof CollectionRunNotPausedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

const controllerPrototype = CollectionRunsHttpController.prototype;
Inject(COLLECTION_RUN_QUEUE_SERVICE)(CollectionRunsHttpController, undefined, 0);
Controller("collection-runs")(CollectionRunsHttpController);

Body()(controllerPrototype, "enqueue", 0);
Req()(controllerPrototype, "enqueue", 1);
Res({ passthrough: true })(controllerPrototype, "enqueue", 2);
Post()(controllerPrototype, "enqueue", Object.getOwnPropertyDescriptor(controllerPrototype, "enqueue")!);
HttpCode(202)(controllerPrototype, "enqueue", Object.getOwnPropertyDescriptor(controllerPrototype, "enqueue")!);
Roles("ADMIN")(controllerPrototype, "enqueue", Object.getOwnPropertyDescriptor(controllerPrototype, "enqueue")!);

Param("runId")(controllerPrototype, "requeue", 0);
Req()(controllerPrototype, "requeue", 1);
Res({ passthrough: true })(controllerPrototype, "requeue", 2);
Post(":runId/requeue")(controllerPrototype, "requeue", Object.getOwnPropertyDescriptor(controllerPrototype, "requeue")!);
HttpCode(202)(controllerPrototype, "requeue", Object.getOwnPropertyDescriptor(controllerPrototype, "requeue")!);
Roles("ADMIN")(controllerPrototype, "requeue", Object.getOwnPropertyDescriptor(controllerPrototype, "requeue")!);
