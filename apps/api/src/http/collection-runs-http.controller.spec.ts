import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";
import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response } from "express";

import { RolesGuard, ROLES_METADATA_KEY } from "../auth/roles.guard.ts";
import {
  createVerifiedPrincipalMiddleware,
  setVerifiedPrincipal
} from "../auth/verified-principal.ts";
import {
  COLLECTION_RUN_QUEUE_SERVICE,
  CollectionRunsHttpController,
  type CollectionRunHttpService
} from "./collection-runs-http.controller.ts";

class FakeCollectionRunService implements CollectionRunHttpService {
  result = { runId: "run-1", coalesced: false };
  requeued = { runId: "run-1" };
  lastActorId: string | null = null;
  async enqueueModelNow(_monitoredModelId: string, actorId: string) {
    this.lastActorId = actorId;
    return this.result;
  }
  async requeuePausedRun() { return this.requeued; }
}

function request(role: string = "ADMIN", actorId = "admin-1"): Request {
  const value = { headers: { "x-role": role, "x-actor-id": actorId } } as unknown as Request;
  setVerifiedPrincipal(value, { role: role === "ADMIN" ? "ADMIN" : "OPERATOR", actorId });
  return value;
}

function response(): Response & { statusCode: number } {
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; }
  } as Response & { statusCode: number };
}

test("declares admin-only manual run and paused requeue endpoints", () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectionRunsHttpController), "collection-runs");
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectionRunsHttpController.prototype.enqueue), "/");
  assert.equal(Reflect.getMetadata(PATH_METADATA, CollectionRunsHttpController.prototype.requeue), ":runId/requeue");
  assert.deepEqual(Reflect.getMetadata(ROLES_METADATA_KEY, CollectionRunsHttpController.prototype.enqueue), ["ADMIN"]);
  assert.deepEqual(Reflect.getMetadata(ROLES_METADATA_KEY, CollectionRunsHttpController.prototype.requeue), ["ADMIN"]);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectionRunsHttpController.prototype.enqueue), 202);
  assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, CollectionRunsHttpController.prototype.requeue), 202);
});

test("manual run defaults to fifty and reports whether existing work coalesced", async () => {
  const service = new FakeCollectionRunService();
  const controller = new CollectionRunsHttpController(service);
  const reply = response();

  const result = await controller.enqueue({ monitoredModelId: "model-1" }, request(), reply);
  assert.deepEqual(result, { runId: "run-1", coalesced: false });
  assert.equal(reply.statusCode, 202);

  service.result = { runId: "run-existing", coalesced: true };
  assert.deepEqual(
    await controller.enqueue({ monitoredModelId: "model-1", searchLimit: 1 }, request(), response()),
    { runId: "run-existing", coalesced: true }
  );
});

test("manual run rejects invalid limits and requeue only exposes its accepted run", async () => {
  const service = new FakeCollectionRunService();
  const controller = new CollectionRunsHttpController(service);

  await assert.rejects(() => controller.enqueue({ monitoredModelId: "model-1", searchLimit: 51 }, request(), response()));
  assert.deepEqual(await controller.requeue("run-1", request(), response()), { runId: "run-1" });
});

test("forged identity headers receive 403 while the configured bearer principal is accepted", async () => {
  const service = new FakeCollectionRunService();
  class AuthHttpTestModule {}
  Module({
    controllers: [CollectionRunsHttpController],
    providers: [
      { provide: COLLECTION_RUN_QUEUE_SERVICE, useValue: service },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (reflector: Reflector) => new RolesGuard(reflector)
      }
    ]
  })(AuthHttpTestModule);
  const app = await NestFactory.create<NestExpressApplication>(AuthHttpTestModule, { logger: false });
  app.use(createVerifiedPrincipalMiddleware({
    adminToken: "test-admin-token-with-at-least-thirty-two-characters",
    adminActorId: "verified-admin"
  }));
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/collection-runs`;

  try {
    const forged = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-role": "ADMIN",
        "x-actor-id": "forged-admin"
      },
      body: JSON.stringify({ monitoredModelId: "model-1" })
    });
    assert.equal(forged.status, 403);
    assert.equal(service.lastActorId, null);

    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin-token-with-at-least-thirty-two-characters",
        "content-type": "application/json"
      },
      body: JSON.stringify({ monitoredModelId: "model-1" })
    });
    assert.equal(accepted.status, 202);
    assert.equal(service.lastActorId, "verified-admin");
  } finally {
    await app.close();
  }
});
