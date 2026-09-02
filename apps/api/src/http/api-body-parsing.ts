import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";

import {
  CollectorAgentAuthenticationError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";

export const COLLECTOR_REPORT_JSON_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_COLLECTOR_REPORT_JSON_LIMIT_BYTES = 64 * 1024 * 1024;

const collectorReportPath = /^\/(?:api\/)?collector-agent\/jobs\/[^/]+\/report\/?$/i;

function authorizationToken(request: Request): string | null {
  const value = request.headers.authorization;
  if (Array.isArray(value)) return null;
  return /^Bearer ([^\s]+)$/i.exec(value ?? "")?.[1] ?? null;
}

function fixedError(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).json({
    statusCode,
    message,
    error: statusCode === 401 ? "Unauthorized"
      : statusCode === 413 ? "Payload Too Large"
      : "Unprocessable Entity"
  });
}

export function parseCollectorReportJsonLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return COLLECTOR_REPORT_JSON_LIMIT_BYTES;
  const match = /^(\d+)(b|kb|mb)$/i.exec(value.trim());
  if (!match) throw new Error("COLLECTOR_REPORT_JSON_LIMIT 必须是正整数并带 b、kb 或 mb 单位");
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > MAX_COLLECTOR_REPORT_JSON_LIMIT_BYTES) {
    throw new Error("COLLECTOR_REPORT_JSON_LIMIT 超出安全范围");
  }
  return bytes;
}

export function configureApiBodyParsing(
  app: NestExpressApplication,
  collectorAgentService: CollectorAgentService,
  jsonLimit = parseCollectorReportJsonLimit(process.env.COLLECTOR_REPORT_JSON_LIMIT)
): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== "POST" || !collectorReportPath.test(request.path)) {
      next();
      return;
    }

    const token = authorizationToken(request);
    if (!token) {
      fixedError(response, 401, "Collector authentication required");
      return;
    }
    void collectorAgentService.assertAuthenticated(token).then(
      () => next(),
      (error: unknown) => {
        if (error instanceof CollectorAgentAuthenticationError) {
          fixedError(response, 401, "Collector authentication failed");
          return;
        }
        fixedError(response, 500, "Collector authentication failed");
      }
    );
  });

  app.useBodyParser("json", { limit: jsonLimit });
  app.useBodyParser("urlencoded", { extended: true });
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    const status = typeof error === "object" && error !== null
      ? Reflect.get(error, "status")
      : null;
    const type = typeof error === "object" && error !== null
      ? Reflect.get(error, "type")
      : null;
    if (status === 413 || type === "entity.too.large") {
      fixedError(response, 413, "Collector request body exceeds the size limit");
      return;
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      fixedError(
        response,
        collectorReportPath.test(request.path) ? 422 : status,
        "Invalid request body"
      );
      return;
    }
    next(error);
  });
}
