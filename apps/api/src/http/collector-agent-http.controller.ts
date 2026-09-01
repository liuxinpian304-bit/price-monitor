import {
  Body,
  type CallHandler,
  type CanActivate,
  ConflictException,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  HttpCode,
  Inject,
  Injectable,
  InternalServerErrorException,
  type NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { isIP } from "node:net";
import type { Request, Response } from "express";
import { memoryStorage } from "multer";
import { z } from "zod";

import {
  collectorReportSchema,
  collectorRunReleaseInputSchema
} from "../../../../packages/contracts/src/index.ts";
import { Roles } from "../auth/roles.guard.ts";
import {
  EvidenceStorePayloadTooLargeError,
  EvidenceStoreUnavailableError,
  EvidenceStoreValidationError,
  MAX_EVIDENCE_BYTES
} from "../collection/collection-evidence-store.ts";
import {
  DesktopReportConflictError,
  DesktopReportIngestionError,
  type DesktopReportIngestionService,
  DesktopReportValidationError,
  wasIngestionNew
} from "../collection/desktop-report-ingestion.service.ts";
import {
  CollectorAgentAuthenticationError,
  CollectorAgentRunOwnershipError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";
import { requestIdentity } from "./identity.ts";

export const COLLECTOR_AGENT_SERVICE = Symbol("COLLECTOR_AGENT_SERVICE");
export const DESKTOP_REPORT_INGESTION_SERVICE = Symbol("DESKTOP_REPORT_INGESTION_SERVICE");

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

const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const evidenceDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const MulterEvidenceInterceptor = FileInterceptor("evidence", {
  storage: memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 }
});

class EvidenceUploadInterceptor implements NestInterceptor {
  private readonly delegate = new MulterEvidenceInterceptor();

  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await this.delegate.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException("Collection evidence exceeds the size limit");
      }
      throw new UnprocessableEntityException("Invalid collection evidence upload");
    }
  }
}

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
  if (error instanceof DesktopReportConflictError) {
    throw new ConflictException("Collector report conflicts with this run");
  }
  if (error instanceof DesktopReportValidationError || error instanceof EvidenceStoreValidationError) {
    throw new UnprocessableEntityException("Invalid collector report or evidence");
  }
  if (error instanceof EvidenceStorePayloadTooLargeError) {
    throw new PayloadTooLargeException("Collection evidence exceeds the size limit");
  }
  if (error instanceof DesktopReportIngestionError || error instanceof EvidenceStoreUnavailableError) {
    throw new InternalServerErrorException("Collector report processing failed");
  }
  throw error;
}

export class CollectorEvidenceAuthenticationGuard implements CanActivate {
  private readonly service: CollectorAgentService;

  constructor(service: CollectorAgentService) {
    this.service = service;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request);
    try {
      await this.service.assertAuthenticated(token);
      return true;
    } catch (error) {
      mapServiceError(error);
    }
  }
}

export class CollectorAgentHttpController {
  private readonly service: CollectorAgentService;
  private readonly reportIngestion: DesktopReportIngestionService;

  constructor(service: CollectorAgentService, reportIngestion: DesktopReportIngestionService) {
    this.service = service;
    this.reportIngestion = reportIngestion;
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

  async release(runId: string, request: Request, body?: unknown) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const input = body === undefined
      ? { disposition: "REQUEUE" as const }
      : validated(collectorRunReleaseInputSchema, body);
    try {
      await this.service.release(token, runId, input);
      return undefined;
    } catch (error) {
      mapServiceError(error);
    }
  }

  async evidence(
    runIdInput: string,
    sha256Input: string,
    file: Express.Multer.File | undefined,
    request: Request,
    response: Response
  ) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const runId = validated(runIdSchema, runIdInput);
    const sha256 = validated(evidenceDigestSchema, sha256Input);
    if (!file || file.mimetype !== "image/png" || !Buffer.isBuffer(file.buffer)) {
      throw new UnprocessableEntityException("Invalid collection evidence upload");
    }
    try {
      const stored = await this.reportIngestion.uploadEvidence(token, runId, sha256, file.buffer);
      response.status(stored.created ? 201 : 200);
      return { evidenceKey: stored.evidenceKey };
    } catch (error) {
      mapServiceError(error);
    }
  }

  async report(runIdInput: string, body: unknown, request: Request, response: Response) {
    const token = bearerToken(request);
    await this.assertAuthenticated(token);
    const runId = validated(runIdSchema, runIdInput);
    const report = validated(collectorReportSchema, body);
    if (
      report.runId !== runId
      || report.status === "PAUSED_LOGIN"
      || report.status === "PAUSED_CHALLENGE"
    ) {
      throw new UnprocessableEntityException("Invalid collector report");
    }
    try {
      const summary = await this.reportIngestion.ingest(token, report);
      response.status(wasIngestionNew(summary) ? 202 : 200);
      return summary;
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

Inject(COLLECTOR_AGENT_SERVICE)(CollectorEvidenceAuthenticationGuard, undefined, 0);
Injectable()(CollectorEvidenceAuthenticationGuard);
Inject(COLLECTOR_AGENT_SERVICE)(CollectorAgentHttpController, undefined, 0);
Inject(DESKTOP_REPORT_INGESTION_SERVICE)(CollectorAgentHttpController, undefined, 1);
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

Param("runId")(controllerPrototype, "release", 0);
Req()(controllerPrototype, "release", 1);
Body()(controllerPrototype, "release", 2);
Post("collector-agent/jobs/:runId/release")(
  controllerPrototype,
  "release",
  Object.getOwnPropertyDescriptor(controllerPrototype, "release")!
);
HttpCode(204)(
  controllerPrototype,
  "release",
  Object.getOwnPropertyDescriptor(controllerPrototype, "release")!
);

Param("runId")(controllerPrototype, "evidence", 0);
Param("sha256")(controllerPrototype, "evidence", 1);
UploadedFile()(controllerPrototype, "evidence", 2);
Req()(controllerPrototype, "evidence", 3);
Res({ passthrough: true })(controllerPrototype, "evidence", 4);
Put("collector-agent/jobs/:runId/evidence/:sha256")(
  controllerPrototype,
  "evidence",
  Object.getOwnPropertyDescriptor(controllerPrototype, "evidence")!
);
HttpCode(200)(
  controllerPrototype,
  "evidence",
  Object.getOwnPropertyDescriptor(controllerPrototype, "evidence")!
);
UseInterceptors(new EvidenceUploadInterceptor())(
  controllerPrototype,
  "evidence",
  Object.getOwnPropertyDescriptor(controllerPrototype, "evidence")!
);
UseGuards(CollectorEvidenceAuthenticationGuard)(
  controllerPrototype,
  "evidence",
  Object.getOwnPropertyDescriptor(controllerPrototype, "evidence")!
);

Param("runId")(controllerPrototype, "report", 0);
Body()(controllerPrototype, "report", 1);
Req()(controllerPrototype, "report", 2);
Res({ passthrough: true })(controllerPrototype, "report", 3);
Post("collector-agent/jobs/:runId/report")(
  controllerPrototype,
  "report",
  Object.getOwnPropertyDescriptor(controllerPrototype, "report")!
);
HttpCode(202)(
  controllerPrototype,
  "report",
  Object.getOwnPropertyDescriptor(controllerPrototype, "report")!
);
