import {
  collectorJobSchema,
  collectorReportSchema,
  type CollectorJob,
  type CollectorReport
} from "@stau-price-monitor/contracts";
import { z } from "zod";

export type CollectorFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

export interface CollectorApiClientOptions {
  apiUrl: string;
  pairingToken: string;
  fetch?: CollectorFetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export type CollectorApiErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "SERVER_ERROR"
  | "HTTP_ERROR"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "TIMEOUT";

export class CollectorApiError extends Error {
  readonly method: string;
  readonly route: string;
  readonly status: number | null;
  readonly code: CollectorApiErrorCode;
  readonly transient: boolean;

  constructor(input: {
    method: string;
    route: string;
    status: number | null;
    code: CollectorApiErrorCode;
    transient: boolean;
  }) {
    super(`Collector API request failed: ${input.code}`);
    this.name = "CollectorApiError";
    this.method = input.method;
    this.route = input.route;
    this.status = input.status;
    this.code = input.code;
    this.transient = input.transient;
  }
}

const claimInputSchema = z.object({
  appVersion: z.string().trim().min(1),
  capabilities: z.array(z.string().trim().min(1))
}).strict();

const progressSchema = z.object({
  discoveredCount: z.number().int().nonnegative().safe(),
  skuCount: z.number().int().nonnegative().safe()
}).strict();

const pauseCodeSchema = z.enum(["LOGIN_REQUIRED", "PLATFORM_CHALLENGE"]);
const evidenceKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const evidenceAcknowledgementSchema = z.object({ evidenceKey: evidenceKeySchema }).strict();
const ingestionSummarySchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "PARTIAL_FAILED", "FAILED"]),
  positionCount: z.number().int().nonnegative().safe(),
  uniqueItemCount: z.number().int().nonnegative().safe(),
  skuCount: z.number().int().nonnegative().safe(),
  issueCount: z.number().int().nonnegative().safe(),
  ownSnapshotIds: z.array(z.string().min(1)),
  competitorSnapshotIds: z.array(z.string().min(1))
}).strict();
const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.enum(["up", "down"]),
  redis: z.enum(["up", "down"]),
  collection: z.object({
    status: z.string().min(1),
    finishedAt: z.iso.datetime({ offset: true }).nullable()
  }).strict(),
  checkedAt: z.iso.datetime({ offset: true })
}).strict();

export type EvidenceAcknowledgement = z.infer<typeof evidenceAcknowledgementSchema>;
export type IngestionSummary = z.infer<typeof ingestionSummarySchema>;
export type CollectorHealth = z.infer<typeof healthSchema>;

function statusCode(status: number): CollectorApiErrorCode {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 409) return "CONFLICT";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

function statusError(method: string, route: string, status: number): CollectorApiError {
  return new CollectorApiError({
    method,
    route,
    status,
    code: statusCode(status),
    transient: status >= 500
  });
}

function contractError(
  method: string,
  route: string,
  code: "INVALID_REQUEST" | "INVALID_RESPONSE"
): CollectorApiError {
  return new CollectorApiError({ method, route, status: null, code, transient: false });
}

function validatedInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  method: string,
  route: string
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw contractError(method, route, "INVALID_REQUEST");
  return result.data;
}

export class CollectorApiClient {
  private readonly apiUrl: string;
  private readonly pairingToken: string;
  private readonly fetch: CollectorFetch;
  private readonly timeoutSignal: (milliseconds: number) => AbortSignal;

  constructor(options: CollectorApiClientOptions) {
    this.apiUrl = options.apiUrl;
    this.pairingToken = options.pairingToken;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;
  }

  async claim(input: { appVersion: string; capabilities: string[] }): Promise<CollectorJob | null> {
    const route = "/api/collector-agent/jobs/claim";
    const body = validatedInput(claimInputSchema, input, "POST", route);
    const response = await this.request("POST", route, route, { json: body });
    if (response.status === 204) return null;
    if (response.status !== 200) throw statusError("POST", route, response.status);
    return this.parseResponse(response, collectorJobSchema, "POST", route);
  }

  async heartbeat(
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<void> {
    const route = "/api/collector-agent/jobs/:runId/heartbeat";
    const body = validatedInput(progressSchema, input, "POST", route);
    const path = `/api/collector-agent/jobs/${encodeURIComponent(runId)}/heartbeat`;
    const response = await this.request("POST", route, path, { json: body });
    this.requireNoContent(response, "POST", route);
  }

  async pause(
    runId: string,
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<void> {
    const route = "/api/collector-agent/jobs/:runId/pause";
    const parsedCode = validatedInput(pauseCodeSchema, code, "POST", route);
    if (!message.trim()) throw contractError("POST", route, "INVALID_REQUEST");
    const path = `/api/collector-agent/jobs/${encodeURIComponent(runId)}/pause`;
    const response = await this.request("POST", route, path, {
      json: { code: parsedCode, message }
    });
    this.requireNoContent(response, "POST", route);
  }

  async uploadEvidence(
    runId: string,
    inputEvidenceKey: string,
    bytes: Uint8Array
  ): Promise<EvidenceAcknowledgement> {
    const route = "/api/collector-agent/jobs/:runId/evidence/:sha256";
    const evidenceKey = validatedInput(evidenceKeySchema, inputEvidenceKey, "PUT", route);
    const digest = evidenceKey.slice("sha256:".length);
    const form = new FormData();
    const copiedBytes = Uint8Array.from(bytes);
    form.append("evidence", new Blob([copiedBytes.buffer], { type: "image/png" }), `${digest}.png`);
    const path = `/api/collector-agent/jobs/${encodeURIComponent(runId)}/evidence/${digest}`;
    const response = await this.request("PUT", route, path, { body: form });
    if (response.status !== 200 && response.status !== 201) {
      throw statusError("PUT", route, response.status);
    }
    const acknowledgement = await this.parseResponse(
      response,
      evidenceAcknowledgementSchema,
      "PUT",
      route
    );
    if (acknowledgement.evidenceKey !== evidenceKey) {
      throw contractError("PUT", route, "INVALID_RESPONSE");
    }
    return acknowledgement;
  }

  async uploadReport(runId: string, inputReport: CollectorReport): Promise<IngestionSummary> {
    const route = "/api/collector-agent/jobs/:runId/report";
    const report = validatedInput(collectorReportSchema, inputReport, "POST", route);
    if (report.runId !== runId || report.status === "PAUSED_LOGIN" || report.status === "PAUSED_CHALLENGE") {
      throw contractError("POST", route, "INVALID_REQUEST");
    }
    const path = `/api/collector-agent/jobs/${encodeURIComponent(runId)}/report`;
    const response = await this.request("POST", route, path, { json: report });
    if (response.status !== 200 && response.status !== 202) {
      throw statusError("POST", route, response.status);
    }
    const summary = await this.parseResponse(response, ingestionSummarySchema, "POST", route);
    if (summary.runId !== runId || summary.status !== report.status) {
      throw contractError("POST", route, "INVALID_RESPONSE");
    }
    return summary;
  }

  async checkReachability(): Promise<CollectorHealth> {
    const route = "/api/health";
    const response = await this.request("GET", route, route, { authenticated: false });
    if (response.status !== 200) throw statusError("GET", route, response.status);
    return this.parseResponse(response, healthSchema, "GET", route);
  }

  async checkPairing(): Promise<void> {
    const route = "/api/collector-agent/jobs/:runId/heartbeat";
    const path = "/api/collector-agent/jobs/__collector_diagnose__/heartbeat";
    const response = await this.request("POST", route, path, {
      json: { discoveredCount: 0, skuCount: 0 }
    });
    if (response.status === 204 || response.status === 409 || response.status === 422) return;
    throw statusError("POST", route, response.status);
  }

  private async request(
    method: string,
    route: string,
    path: string,
    options: { json?: unknown; body?: BodyInit; authenticated?: boolean }
  ): Promise<Response> {
    const signal = this.timeoutSignal(15_000);
    const headers = new Headers();
    if (options.authenticated !== false) headers.set("authorization", `Bearer ${this.pairingToken}`);
    let body = options.body;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      try {
        body = JSON.stringify(options.json);
      } catch {
        throw contractError(method, route, "INVALID_REQUEST");
      }
    }

    try {
      const init: RequestInit = { method, headers, signal };
      if (body !== undefined) init.body = body;
      return await this.fetch(`${this.apiUrl}${path}`, init);
    } catch {
      throw new CollectorApiError({
        method,
        route,
        status: null,
        code: signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        transient: true
      });
    }
  }

  private requireNoContent(response: Response, method: string, route: string): void {
    if (response.status !== 204) throw statusError(method, route, response.status);
  }

  private async parseResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
    method: string,
    route: string
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw contractError(method, route, "INVALID_RESPONSE");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw contractError(method, route, "INVALID_RESPONSE");
    return parsed.data;
  }
}
