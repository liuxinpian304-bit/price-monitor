import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";

import { requestIdentity } from "./identity.ts";

function requestWithActor(actorId?: string): Request {
  return {
    headers: actorId === undefined ? {} : { "x-actor-id": actorId }
  } as Request;
}

test("decodes a URI-prefixed Chinese actor ID", () => {
  const encoded = `uri:${encodeURIComponent("本地运营")}`;
  assert.equal(requestIdentity(requestWithActor(encoded)).actorId, "本地运营");
});

test("preserves an unprefixed ASCII actor ID", () => {
  assert.equal(requestIdentity(requestWithActor("operator-9")).actorId, "operator-9");
});

test("falls back for malformed, empty, or missing encoded actor IDs", () => {
  assert.equal(requestIdentity(requestWithActor("uri:%E6%ZZ")).actorId, "local-operator");
  assert.equal(requestIdentity(requestWithActor("uri:")).actorId, "local-operator");
  assert.equal(requestIdentity(requestWithActor()).actorId, "local-operator");
});
