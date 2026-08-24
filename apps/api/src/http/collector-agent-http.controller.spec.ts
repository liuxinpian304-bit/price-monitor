import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import type { Request, Response } from "express";

import { ROLES_METADATA_KEY } from "../auth/roles.guard.ts";
import {
  CollectorAgentAuthenticationError,
  CollectorAgentRunOwnershipError,
  type CollectorAgentService
} from "../collector-agent/collector-agent.service.ts";
import { createCollectorToken } from "../collector-agent/collector-token.ts";
import { CollectorAgentHttpController } from "./collector-agent-http.controller.ts";

const claimedJob = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-1",
  monitoredModelId: "model-1",
  searchQuery: "Sony MDR-7506",
  searchLimit: 50,
  ownShopName: "Own Shop",
  ownListings: [],
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
  const controller = new CollectorAgentHttpController(service as unknown as CollectorAgentService);
  return { controller, service };
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
  assert.deepEqual(
    Reflect.getMetadata(ROLES_METADATA_KEY, CollectorAgentHttpController.prototype.register),
    ["ADMIN"]
  );
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.claim), 200);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.heartbeat), 204);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectorAgentHttpController.prototype.pause), 204);
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
    const { controller, service } = createController();
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

    assert.equal(service.claimCalls, 0);
    assert.equal(service.heartbeatCalls, 0);
    assert.equal(service.pauseCalls, 0);
  }
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
