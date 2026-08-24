import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException
} from "@nestjs/common";
import { isIP } from "node:net";
import type { Request, Response } from "express";
import { z } from "zod";

import { Roles } from "../auth/roles.guard.ts";
import {
  CollectorAgentAuthenticationError,
  CollectorAgentRunOwnershipError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";
import { requestIdentity } from "./identity.ts";

export const COLLECTOR_AGENT_SERVICE = Symbol("COLLECTOR_AGENT_SERVICE");

const registrationSchema = z.object({
  name: z.string().trim().min(1),
  platform: z.enum(["MACOS", "WINDOWS"])
}).strict();

const claimSchema = z.object({
  appVersion: z.string().trim().min(1),
  capabilities: z.array(z.string().trim().min(1))
}).strict();

const heartbeatSchema = z.object({
  discoveredCount: z.number().int().nonnegative().safe(),
  skuCount: z.number().int().nonnegative().safe()
}).strict();

const pauseSchema = z.object({
  code: z.enum(["LOGIN_REQUIRED", "PLATFORM_CHALLENGE"]),
  message: z.string().trim().min(1)
}).strict();

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new UnprocessableEntityException("Invalid collector request");
  return result.data;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? undefined : authorization;
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? "");
  if (!match?.[1]) throw new UnauthorizedException("Collector authentication required");
  return match[1];
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.split("%")[0];
  if (normalized === "::1") return true;
  if (normalized?.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
  return isIP(normalized ?? "") === 4 && normalized?.split(".")[0] === "127";
}

function requireLoopback(request: Request): void {
  if (!isLoopbackAddress(request.socket.remoteAddress ?? request.ip)) {
    throw new ForbiddenException("Collector enrollment is restricted to loopback");
  }
}

function mapServiceError(error: unknown): never {
  if (error instanceof CollectorAgentAuthenticationError) {
    throw new UnauthorizedException("Collector authentication failed");
  }
  if (error instanceof CollectorAgentRunOwnershipError) {
    throw new ConflictException("Collector does not own this run");
  }
  throw error;
}

export class CollectorAgentHttpController {
  private readonly service: CollectorAgentService;

  constructor(service: CollectorAgentService) {
    this.service = service;
  }

  async register(body: unknown, request: Request) {
    requireLoopback(request);
    const input = validated(registrationSchema, body);
    return this.service.register(input, requestIdentity(request).actorId);
  }

  async claim(body: unknown, request: Request, response: Response) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const input = validated(claimSchema, body);
    try {
      const job = await this.service.claimNext(token, input);
      if (!job) {
        response.status(204);
        return undefined;
      }
      return job;
    } catch (error) {
      mapServiceError(error);
    }
  }

  async heartbeat(runId: string, body: unknown, request: Request) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const input = validated(heartbeatSchema, body);
    try {
      await this.service.heartbeat(token, runId, input);
      return undefined;
    } catch (error) {
      mapServiceError(error);
    }
  }

  async pause(runId: string, body: unknown, request: Request) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const input = validated(pauseSchema, body);
    try {
      await this.service.pause(token, runId, input.code, input.message);
      return undefined;
    } catch (error) {
      mapServiceError(error);
    }
  }

  private async assertAuthenticated(token: string): Promise<void> {
    try {
      await this.service.assertAuthenticated(token);
    } catch (error) {
      mapServiceError(error);
    }
  }
}

const controllerPrototype = CollectorAgentHttpController.prototype;

Inject(COLLECTOR_AGENT_SERVICE)(CollectorAgentHttpController, undefined, 0);
Controller()(CollectorAgentHttpController);

Body()(controllerPrototype, "register", 0);
Req()(controllerPrototype, "register", 1);
Post("collector-agents")(
  controllerPrototype,
  "register",
  Object.getOwnPropertyDescriptor(controllerPrototype, "register")!
);
Roles("ADMIN")(
  controllerPrototype,
  "register",
  Object.getOwnPropertyDescriptor(controllerPrototype, "register")!
);

Body()(controllerPrototype, "claim", 0);
Req()(controllerPrototype, "claim", 1);
Res({ passthrough: true })(controllerPrototype, "claim", 2);
Post("collector-agent/jobs/claim")(
  controllerPrototype,
  "claim",
  Object.getOwnPropertyDescriptor(controllerPrototype, "claim")!
);
HttpCode(200)(
  controllerPrototype,
  "claim",
  Object.getOwnPropertyDescriptor(controllerPrototype, "claim")!
);

Param("runId")(controllerPrototype, "heartbeat", 0);
Body()(controllerPrototype, "heartbeat", 1);
Req()(controllerPrototype, "heartbeat", 2);
Post("collector-agent/jobs/:runId/heartbeat")(
  controllerPrototype,
  "heartbeat",
  Object.getOwnPropertyDescriptor(controllerPrototype, "heartbeat")!
);
HttpCode(204)(
  controllerPrototype,
  "heartbeat",
  Object.getOwnPropertyDescriptor(controllerPrototype, "heartbeat")!
);

Param("runId")(controllerPrototype, "pause", 0);
Body()(controllerPrototype, "pause", 1);
Req()(controllerPrototype, "pause", 2);
Post("collector-agent/jobs/:runId/pause")(
  controllerPrototype,
  "pause",
  Object.getOwnPropertyDescriptor(controllerPrototype, "pause")!
);
HttpCode(204)(
  controllerPrototype,
  "pause",
  Object.getOwnPropertyDescriptor(controllerPrototype, "pause")!
);
