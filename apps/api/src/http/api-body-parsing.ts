import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";

import {
  CollectorAgentAuthenticationError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";

export const COLLECTOR_REPORT_JSON_LIMIT_BYTES = 8 * 1024 * 1024;

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

export function configureApiBodyParsing(
  app: NestExpressApplication,
  collectorAgentService: CollectorAgentService
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

  app.useBodyParser("json", { limit: COLLECTOR_REPORT_JSON_LIMIT_BYTES });
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
