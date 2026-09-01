import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";
import { Module } from "@nestjs/common";
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response } from "express";

import type { CollectorReport } from "../../../../packages/contracts/src/index.ts";
import { ROLES_METADATA_KEY } from "../auth/roles.guard.ts";
import {
  EvidenceStorePayloadTooLargeError,
  EvidenceStoreValidationError
} from "../collection/collection-evidence-store.ts";
import {
  DesktopReportConflictError,
  DesktopReportIngestionError,
  DesktopReportValidationError,
  INGESTION_DISPOSITION,
  type DesktopReportIngestionService,
  type IngestionSummary
} from "../collection/desktop-report-ingestion.service.ts";
import {
  CollectorAgentAuthenticationError,
  CollectorAgentRunOwnershipError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";
import { createCollectorToken } from "../collector-agent/collector-token.ts";
import {
  COLLECTOR_AGENT_SERVICE,
  DESKTOP_REPORT_INGESTION_SERVICE,
  CollectorEvidenceAuthenticationGuard,
  CollectorAgentHttpController
} from "./collector-agent-http.controller.ts";
import { configureApiBodyParsing, parseCollectorReportJsonLimit } from "./api-body-parsing.ts";

const claimedJob = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-1",
  monitoredModelId: "model-1",
  searchQuery: "Sony MDR-7506",
  searchLimit: 50,
  ownShopName: "Own Shop",
  ownListings: [{
    id: "own-1",
    url: "https://item.taobao.com/item.htm?id=1001",
    skuText: "Black"
  }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    effectiveAliases: ["7506"],
    excludedAliases: [],
    mustIncludeTerms: [],
    excludedTerms: []
  }
} as const;

function reportFixture(): CollectorReport {
  return {
    schemaVersion: 1,
    runId: "run-1",
    collectorId: "agent-1",
    appVersion: "2.4.5",
    startedAt: "2026-08-24T01:30:00.000Z",
    completedAt: "2026-08-24T01:31:00.000Z",
    status: "SUCCEEDED",
    searchLimit: 1,
    searchTerminationReason: "END_MARKER",
    positions: [],
    ownItems: [{
      ownListingId: "own-1",
      platformItemId: "1001",
      url: "https://item.taobao.com/item.htm?id=1001",
      shopName: "Own Shop",
      title: "Sony MDR-7506",
      searchRanks: [],
      skus: [{
        skuId: "black",
        label: "Black",
        attributes: { color: "Black" },
        stockState: "IN_STOCK",
        listPriceFen: 1_000,
        activityPriceFen: 1_000,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        promotions: [],
        mandatoryFeeFen: 0,
        priceConfidence: "CONFIRMED",
        payableFen: 1_000,
        capturedAt: "2026-08-24T01:30:30.000Z",
        evidenceKey: null
      }]
    }],
    competitorItems: [],
    issues: []
  };
}

const ingestionSummary: IngestionSummary = {
  runId: "run-1",
  status: "SUCCEEDED",
  positionCount: 0,
  uniqueItemCount: 0,
  skuCount: 1,
  issueCount: 0,
  ownSnapshotIds: ["own-snapshot-1"],
  competitorSnapshotIds: []
};

class FakeCollectorAgentService {
  readonly registrationToken = createCollectorToken().plaintext;
  claimResult: typeof claimedJob | null = claimedJob;
  invalidToken = false;
  disabledToken = false;
  wrongOwner = false;
  authenticationCalls = 0;
  registrationCalls = 0;
  claimCalls = 0;
  heartbeatCalls = 0;
  pauseCalls = 0;
  releaseCalls = 0;
  releaseInput: unknown;

  async register(input: { name: string; platform: "MACOS" | "WINDOWS" }, _actorId: string) {
    this.registrationCalls += 1;
    return { id: "agent-1", name: input.name, token: this.registrationToken };
  }

  async assertAuthenticated(_token: string): Promise<void> {
    this.authenticationCalls += 1;
    if (this.invalidToken || this.disabledToken) throw new CollectorAgentAuthenticationError();
  }

  async claimNext(_token: string, _input: { appVersion: string; capabilities: string[] }) {
    this.claimCalls += 1;
    if (this.invalidToken || this.disabledToken) throw new CollectorAgentAuthenticationError();
    return this.claimResult;
  }

  async heartbeat(
    _token: string,
    _runId: string,
    _input: { discoveredCount: number; skuCount: number }
  ): Promise<void> {
    this.heartbeatCalls += 1;
    if (this.invalidToken || this.disabledToken) throw new CollectorAgentAuthenticationError();
    if (this.wrongOwner) throw new CollectorAgentRunOwnershipError();
  }

  async pause(
    _token: string,
    _runId: string,
    _code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    _message: string
  ): Promise<void> {
    this.pauseCalls += 1;
    if (this.invalidToken || this.disabledToken) throw new CollectorAgentAuthenticationError();
    if (this.wrongOwner) throw new CollectorAgentRunOwnershipError();
  }

  async release(_token: string, _runId: string, input?: unknown): Promise<void> {
    this.releaseCalls += 1;
    this.releaseInput = input;
    if (this.invalidToken || this.disabledToken) throw new CollectorAgentAuthenticationError();
    if (this.wrongOwner) throw new CollectorAgentRunOwnershipError();
  }
}

class FakeDesktopReportIngestionService {
  reportCalls = 0;
  evidenceCalls = 0;
  newlyAccepted = true;
  newlyStored = true;
  reportError: unknown;
  evidenceError: unknown;

  async ingest(_token: string, report: CollectorReport): Promise<IngestionSummary> {
    this.reportCalls += 1;
    if (this.reportError) throw this.reportError;
    const result: IngestionSummary = { ...ingestionSummary, status: report.status as IngestionSummary["status"] };
    Object.defineProperty(result, INGESTION_DISPOSITION, {
      value: this.newlyAccepted ? "created" : "existing"
    });
    return result;
  }

  async uploadEvidence(_token: string, _runId: string, sha256: string, _bytes: Uint8Array) {
    this.evidenceCalls += 1;
    if (this.evidenceError) throw this.evidenceError;
    return { evidenceKey: `sha256:${sha256}`, created: this.newlyStored };
  }
}

function request(input: { authorization?: string; remoteAddress?: string; role?: string } = {}): Request {
  return {
    headers: {
      authorization: input.authorization,
      "x-role": input.role,
      "x-actor-id": "admin-test"
    },
    ip: input.remoteAddress,
    socket: { remoteAddress: input.remoteAddress }
  } as unknown as Request;
}

function response(): Response & { statusCode: number } {
  return {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    }
  } as Response & { statusCode: number };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const getStatus = Reflect.get(error, "getStatus");
  return typeof getStatus === "function" ? getStatus.call(error) : undefined;
}

function createController() {
  const service = new FakeCollectorAgentService();
  const ingestion = new FakeDesktopReportIngestionService();
  const controller = new CollectorAgentHttpController(
    service as unknown as CollectorAgentService,
    ingestion as unknown as DesktopReportIngestionService
  );
  return { controller, service, ingestion };
}

test("declares the exact registration and collector-agent route paths and response codes", () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController), "/");
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.register), "collector-agents");
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.claim), "collector-agent/jobs/claim");
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.heartbeat),
    "collector-agent/jobs/:runId/heartbeat"
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.pause),
    "collector-agent/jobs/:runId/pause"
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.release),
    "collector-agent/jobs/:runId/release"
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.evidence),
    "collector-agent/jobs/:runId/evidence/:sha256"
  );
  assert.equal(
    Reflect.getMetadata(PATH_METADATA, CollectorAgentHttpController.prototype.report),
    "collector-agent/jobs/:runId/report"
  );
  assert.deepEqual(
    Reflect.getMetadata(ROLES_METADATA_KEY, CollectorAgentHttpController.prototype.register),
    ["ADMIN"]
  );
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.claim), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.heartbeat), 204);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.pause), 204);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.release), 204);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.evidence), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.report), 202);
});

test("registration returns the one-time token only for loopback admin requests", async () => {
  const { controller, service } = createController();

  const registered = await controller.register(
    { name: "mac-studio-1", platform: "MACOS" },
    request({ remoteAddress: "::ffff:127.0.0.1", role: "ADMIN" })
  );
  assert.equal(registered.token, service.registrationToken);
  assert.equal(service.registrationCalls, 1);

  await assert.rejects(
    () => controller.register(
      { name: "remote-mac", platform: "MACOS" },
      request({ remoteAddress: "10.0.0.8", role: "ADMIN" })
    ),
    (error) => statusOf(error) === 403
  );
  await assert.rejects(
    () => controller.register(
      { name: "invalid-loopback", platform: "MACOS" },
      request({ remoteAddress: "127.999.999.999", role: "ADMIN" })
    ),
    (error) => statusOf(error) === 403
  );
  assert.equal(service.registrationCalls, 1);
});

test("agent routes require a bearer token and map invalid tokens to 401", async () => {
  const { controller, service } = createController();

  await assert.rejects(
    () => controller.claim({ appVersion: "2.4.5", capabilities: [] }, request(), response()),
    (error) => statusOf(error) === 401
  );
  await assert.rejects(
    () => controller.claim(
      { appVersion: "2.4.5", capabilities: [] },
      request({ authorization: "Token invalid" }),
      response()
    ),
    (error) => statusOf(error) === 401
  );

  service.invalidToken = true;
  await assert.rejects(
    () => controller.claim(
      { appVersion: "2.4.5", capabilities: [] },
      request({ authorization: "Bearer invalid" }),
      response()
    ),
    (error) => statusOf(error) === 401
  );
});

test("invalid or disabled authentication takes precedence over malformed bodies", async () => {
  for (const authenticationState of ["invalidToken", "disabledToken"] as const) {
    const { controller, service, ingestion } = createController();
    service[authenticationState] = true;
    const authenticated = request({ authorization: "Bearer syntactically-valid" });

    await assert.rejects(
      () => controller.claim({ appVersion: "", capabilities: "invalid" }, authenticated, response()),
      (error) => statusOf(error) === 401
    );
    await assert.rejects(
      () => controller.heartbeat("run-1", { discoveredCount: -1, skuCount: 2 }, authenticated),
      (error) => statusOf(error) === 401
    );
    await assert.rejects(
      () => controller.pause("run-1", { code: "RETRY", message: "" }, authenticated),
      (error) => statusOf(error) === 401
    );
    await assert.rejects(
      () => controller.release("run-1", authenticated),
      (error) => statusOf(error) === 401
    );
    await assert.rejects(
      () => controller.report("run-1", { rejected: "account text" }, authenticated, response()),
      (error) => statusOf(error) === 401
    );
    await assert.rejects(
      () => controller.evidence("run-1", "NOT-A-HASH", undefined, authenticated, response()),
      (error) => statusOf(error) === 401
    );

    assert.equal(service.claimCalls, 0);
    assert.equal(service.heartbeatCalls, 0);
    assert.equal(service.pauseCalls, 0);
    assert.equal(service.releaseCalls, 0);
    assert.equal(ingestion.reportCalls, 0);
    assert.equal(ingestion.evidenceCalls, 0);
  }
});

test("evidence HTTP authentication runs before Multer parses or buffers the body", async () => {
  const service = new FakeCollectorAgentService();
  const ingestion = new FakeDesktopReportIngestionService();
  class EvidenceHttpTestModule {}
  Module({
    controllers: [CollectorAgentHttpController],
    providers: [
      { provide: COLLECTOR_AGENT_SERVICE, useValue: service },
      { provide: DESKTOP_REPORT_INGESTION_SERVICE, useValue: ingestion },
      CollectorEvidenceAuthenticationGuard
    ]
  })(EvidenceHttpTestModule);

  const app = await NestFactory.create(EvidenceHttpTestModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address !== "string");
  const route = `http://127.0.0.1:${address.port}/collector-agent/jobs/run-1/evidence/${"a".repeat(64)}`;

  try {
    const oversized = new FormData();
    const oversizedBytes = new Uint8Array(2 * 1024 * 1024 + 1);
    oversized.set("evidence", new Blob([oversizedBytes.buffer as ArrayBuffer], { type: "image/png" }), "large.png");
    const missingToken = await fetch(route, { method: "PUT", body: oversized });
    assert.equal(missingToken.status, 401);

    service.invalidToken = true;
    const invalidToken = await fetch(route, {
      method: "PUT",
      headers: {
        authorization: "Bearer invalid",
        "content-type": "multipart/form-data"
      },
      body: "malformed account text"
    });
    assert.equal(invalidToken.status, 401);
    assert.equal(ingestion.evidenceCalls, 0);

    service.invalidToken = false;
    const authenticatedOversized = new FormData();
    authenticatedOversized.set(
      "evidence",
      new Blob([oversizedBytes.buffer as ArrayBuffer], { type: "image/png" }),
      "large.png"
    );
    const oversizedResponse = await fetch(route, {
      method: "PUT",
      headers: { authorization: "Bearer valid" },
      body: authenticatedOversized
    });
    assert.equal(oversizedResponse.status, 413);

    const malformedResponse = await fetch(route, {
      method: "PUT",
      headers: {
        authorization: "Bearer valid",
        "content-type": "multipart/form-data"
      },
      body: "malformed account text"
    });
    assert.equal(malformedResponse.status, 422);
    assert.equal(ingestion.evidenceCalls, 0);
  } finally {
    await app.close();
  }
});

test("report HTTP authentication runs before JSON buffering and parsing", async () => {
  const service = new FakeCollectorAgentService();
  const ingestion = new FakeDesktopReportIngestionService();
  class ReportHttpTestModule {}
  Module({
    controllers: [CollectorAgentHttpController],
    providers: [
      { provide: COLLECTOR_AGENT_SERVICE, useValue: service },
      { provide: DESKTOP_REPORT_INGESTION_SERVICE, useValue: ingestion },
      CollectorEvidenceAuthenticationGuard
    ]
  })(ReportHttpTestModule);

  const app = await NestFactory.create<NestExpressApplication>(
    ReportHttpTestModule,
    { logger: false, bodyParser: false }
  );
  app.setGlobalPrefix("api");
  configureApiBodyParsing(app, service as unknown as CollectorAgentService);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert.equal(typeof address, "object");
  assert.ok(address && typeof address !== "string");
  const route = `http://127.0.0.1:${address.port}/api/collector-agent/jobs/run-1/report`;
  const uppercaseRoute = `http://127.0.0.1:${address.port}/API/COLLECTOR-AGENT/JOBS/run-1/REPORT`;
  const oversized = JSON.stringify({ value: "x".repeat(8 * 1024 * 1024 + 1) });
  const malformed = "{\"account-prefix-that-must-not-echo\":";

  try {
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", authorization: "Bearer invalid" }
    ]) {
      service.invalidToken = headers.authorization !== undefined;
      const response = await fetch(route, { method: "POST", headers, body: oversized });
      assert.equal(response.status, 401);
    }

    service.invalidToken = false;
    const uppercaseMissingToken = await fetch(uppercaseRoute, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized
    });
    assert.equal(uppercaseMissingToken.status, 401);

    service.invalidToken = true;
    const invalidMalformed = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: malformed
    });
    assert.equal(invalidMalformed.status, 401);

    service.invalidToken = false;
    const authenticatedOversized = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid" },
      body: oversized
    });
    assert.equal(authenticatedOversized.status, 413);

    const authenticatedMalformed = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid" },
      body: malformed
    });
    assert.ok(authenticatedMalformed.status === 400 || authenticatedMalformed.status === 422);
    assert.equal((await authenticatedMalformed.text()).includes("account-prefix-that-must-not-echo"), false);
    assert.equal(ingestion.reportCalls, 0);
  } finally {
    await app.close();
  }
});

test("report JSON body limit defaults to 8 MiB and rejects unsafe configuration", () => {
  assert.equal(parseCollectorReportJsonLimit(undefined), 8 * 1024 * 1024);
  assert.equal(parseCollectorReportJsonLimit("2mb"), 2 * 1024 * 1024);
  for (const invalid of ["0", "-1", "9gb", "nonsense", "1.5mb"]) {
    assert.throws(() => parseCollectorReportJsonLimit(invalid));
  }
});

test("evidence upload returns 201 once and 200 for an identical repeat", async () => {
  const { controller, ingestion } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });
  const sha256 = "a".repeat(64);
  const file = {
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mimetype: "image/png"
  } as Express.Multer.File;

  const created = response();
  assert.deepEqual(await controller.evidence("run-1", sha256, file, authenticated, created), {
    evidenceKey: `sha256:${sha256}`
  });
  assert.equal(created.statusCode, 201);

  ingestion.newlyStored = false;
  const repeated = response();
  assert.deepEqual(await controller.evidence("run-1", sha256, file, authenticated, repeated), {
    evidenceKey: `sha256:${sha256}`
  });
  assert.equal(repeated.statusCode, 200);
});

test("report upload validates the HTTP body and returns 202 once then 200", async () => {
  const { controller, ingestion } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });
  const report = reportFixture();

  const accepted = response();
  assert.deepEqual(await controller.report("run-1", report, authenticated, accepted), ingestionSummary);
  assert.equal(accepted.statusCode, 202);

  ingestion.newlyAccepted = false;
  const repeated = response();
  assert.deepEqual(await controller.report("run-1", report, authenticated, repeated), ingestionSummary);
  assert.equal(repeated.statusCode, 200);

  for (const invalid of [
    { path: "run-other", body: reportFixture() },
    { path: "run-1", body: { ...reportFixture(), status: "PAUSED_LOGIN" } },
    { path: "run-1", body: { ...reportFixture(), completedAt: "not-a-time" } }
  ]) {
    await assert.rejects(
      () => controller.report(invalid.path, invalid.body, authenticated, response()),
      (error) => statusOf(error) === 422
    );
  }
  assert.equal(ingestion.reportCalls, 2);
});

test("maps report ownership/state, validation, payload, and persistence failures safely", async () => {
  const authenticated = request({ authorization: "Bearer pmc_test" });
  const cases: Array<{ error: unknown; status: number }> = [
    { error: new DesktopReportConflictError(), status: 409 },
    { error: new DesktopReportValidationError(), status: 422 },
    { error: new EvidenceStoreValidationError(), status: 422 },
    { error: new EvidenceStorePayloadTooLargeError(), status: 413 },
    { error: new DesktopReportIngestionError(), status: 500 }
  ];

  for (const entry of cases) {
    const { controller, ingestion } = createController();
    ingestion.reportError = entry.error;
    await assert.rejects(
      () => controller.report("run-1", reportFixture(), authenticated, response()),
      (error) => statusOf(error) === entry.status
    );
  }

  const { controller, ingestion } = createController();
  ingestion.evidenceError = new DesktopReportConflictError();
  await assert.rejects(
    () => controller.evidence(
      "run-1",
      "a".repeat(64),
      { buffer: Buffer.alloc(8), mimetype: "image/png" } as Express.Multer.File,
      authenticated,
      response()
    ),
    (error) => statusOf(error) === 409
  );
});

test("graceful release returns 204 and delegates ownership fencing", async () => {
  const { controller, service } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });

  assert.equal(await controller.release("run-1", authenticated), undefined);
  assert.equal(service.releaseCalls, 1);
});

test("validated checkpoint quarantine is delegated as a terminal release", async () => {
  const { controller, service } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });
  const quarantine = { disposition: "QUARANTINE", errorCode: "INVALID_CHECKPOINT" } as const;

  assert.equal(await controller.release("run-1", authenticated, quarantine), undefined);
  assert.deepEqual(service.releaseInput, quarantine);
});

test("missing or mislabeled evidence is rejected without invoking storage", async () => {
  const { controller, ingestion } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });

  await assert.rejects(
    () => controller.evidence("run-1", "a".repeat(64), undefined, authenticated, response()),
    (error) => statusOf(error) === 422
  );
  await assert.rejects(
    () => controller.evidence(
      "run-1",
      "a".repeat(64),
      { buffer: Buffer.alloc(8), mimetype: "application/octet-stream" } as Express.Multer.File,
      authenticated,
      response()
    ),
    (error) => statusOf(error) === 422
  );
  assert.equal(ingestion.evidenceCalls, 0);
});

test("claim returns a job with 200 and uses 204 when no job exists", async () => {
  const { controller, service } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });
  const foundResponse = response();

  assert.equal(
    (await controller.claim({ appVersion: "2.4.5", capabilities: ["accessibility"] }, authenticated, foundResponse))?.runId,
    "run-1"
  );
  assert.equal(foundResponse.statusCode, 200);

  service.claimResult = null;
  const emptyResponse = response();
  assert.equal(await controller.claim({ appVersion: "2.4.5", capabilities: [] }, authenticated, emptyResponse), undefined);
  assert.equal(emptyResponse.statusCode, 204);
});

test("wrong run ownership maps to 409", async () => {
  const { controller, service } = createController();
  service.wrongOwner = true;
  const authenticated = request({ authorization: "Bearer pmc_test" });

  await assert.rejects(
    () => controller.heartbeat("run-other", { discoveredCount: 1, skuCount: 2 }, authenticated),
    (error) => statusOf(error) === 409
  );
  await assert.rejects(
    () => controller.pause(
      "run-other",
      { code: "LOGIN_REQUIRED", message: "login expired" },
      authenticated
    ),
    (error) => statusOf(error) === 409
  );
  await assert.rejects(
    () => controller.release("run-other", authenticated),
    (error) => statusOf(error) === 409
  );
});

test("invalid progress and pause bodies return 422 without invoking the service", async () => {
  const { controller, service } = createController();
  const authenticated = request({ authorization: "Bearer pmc_test" });

  await assert.rejects(
    () => controller.claim({ appVersion: "", capabilities: "invalid" }, authenticated, response()),
    (error) => statusOf(error) === 422
  );
  await assert.rejects(
    () => controller.heartbeat("run-1", { discoveredCount: -1, skuCount: 2 }, authenticated),
    (error) => statusOf(error) === 422
  );
  assert.equal(service.claimCalls, 0);
  await assert.rejects(
    () => controller.pause(
      "run-1",
      { code: "RETRY" as "LOGIN_REQUIRED", message: "retry" },
      authenticated
    ),
    (error) => statusOf(error) === 422
  );
  assert.equal(service.heartbeatCalls, 0);
  assert.equal(service.pauseCalls, 0);
});
