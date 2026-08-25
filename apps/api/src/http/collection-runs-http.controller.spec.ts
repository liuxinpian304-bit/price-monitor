import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";
import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import type { Request, Response } from "express";

import { ROLES_METADATA_KEY } from "../auth/roles.guard.ts";
import {
  CollectionRunsHttpController,
  type CollectionRunHttpService
} from "./collection-runs-http.controller.ts";

class FakeCollectionRunService implements CollectionRunHttpService {
  result = { runId: "run-1", coalesced: false };
  requeued = { runId: "run-1" };
  async enqueueModelNow() { return this.result; }
  async requeuePausedRun() { return this.requeued; }
}

function request(role: string = "ADMIN", actorId = "admin-1"): Request {
  return { headers: { "x-role": role, "x-actor-id": actorId } } as unknown as Request;
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
