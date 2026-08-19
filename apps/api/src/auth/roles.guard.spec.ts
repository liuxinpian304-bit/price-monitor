import assert from "node:assert/strict";
import test from "node:test";

import { roleFromHeaders, roleIsAllowed } from "./roles.guard.ts";

test("missing or unknown role headers default to operator", () => {
  assert.equal(roleFromHeaders(undefined), "OPERATOR");
  assert.equal(roleFromHeaders("owner"), "OPERATOR");
});

test("admin header is normalized and allowed for admin-only routes", () => {
  assert.equal(roleFromHeaders("admin"), "ADMIN");
  assert.equal(roleIsAllowed("ADMIN", ["ADMIN"]), true);
  assert.equal(roleIsAllowed("OPERATOR", ["ADMIN"]), false);
});
