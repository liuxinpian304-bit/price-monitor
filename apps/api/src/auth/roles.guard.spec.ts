import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { RolesGuard, roleIsAllowed } from "./roles.guard.ts";
import {
  adminPrincipalConfigFromEnvironment,
  createVerifiedPrincipalMiddleware,
  setVerifiedPrincipal,
  verifiedPrincipal
} from "./verified-principal.ts";

function context(request: object): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;
}

test("role checks use only a verified principal and ignore forged identity headers", () => {
  const reflector = new Reflector();
  reflector.getAllAndOverride = () => ["ADMIN"];
  const guard = new RolesGuard(reflector);
  const forged = { headers: { "x-role": "ADMIN", "x-actor-id": "admin" } };

  assert.equal(guard.canActivate(context(forged)), false);
  setVerifiedPrincipal(forged, { role: "ADMIN", actorId: "verified-admin" });
  assert.equal(guard.canActivate(context(forged)), true);
  assert.equal(roleIsAllowed("ADMIN", ["ADMIN"]), true);
  assert.equal(roleIsAllowed("OPERATOR", ["ADMIN"]), false);
});

test("administrator access is disabled without a token and rejects weak configuration", () => {
  const disabled = adminPrincipalConfigFromEnvironment({});
  assert.deepEqual(disabled, {
    adminToken: null,
    adminActorId: "local-admin"
  });
  const request = { headers: { authorization: "Bearer test-client-supplied-value" } };
  createVerifiedPrincipalMiddleware(disabled)(request as never, {} as never, () => undefined);
  assert.deepEqual(verifiedPrincipal(request), { actorId: "local-operator", role: "OPERATOR" });
  assert.throws(
    () => adminPrincipalConfigFromEnvironment({ ["ADMIN_API_TOKEN"]: "test-too-short" }),
    /at least 32 characters/
  );
});

test("production rejects a missing administrator token without reflecting secret input", () => {
  assert.throws(
    () => adminPrincipalConfigFromEnvironment({ NODE_ENV: "production" }),
    /ADMIN_API_TOKEN is required/
  );
  const weak = "this-token-is-still-too-short";
  let caught: unknown;
  try {
    adminPrincipalConfigFromEnvironment({ NODE_ENV: "production", ["ADMIN_API_TOKEN"]: weak });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message.includes(weak), false);
});
