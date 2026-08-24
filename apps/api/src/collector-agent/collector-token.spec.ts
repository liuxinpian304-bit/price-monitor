import assert from "node:assert/strict";
import test from "node:test";

import { createCollectorToken, verifyCollectorToken } from "./collector-token.ts";

test("creates a high-entropy token and stores only its hash", () => {
  const token = createCollectorToken();

  assert.match(token.plaintext, /^pmc_[A-Za-z0-9_-]{43}$/);
  assert.match(token.hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(token.plaintext, token.hash);
  assert.equal(verifyCollectorToken(token.plaintext, token.hash), true);
  assert.equal(verifyCollectorToken(`${token.plaintext}x`, token.hash), false);
});

test("rejects malformed stored hashes without throwing", () => {
  const token = createCollectorToken();

  assert.equal(verifyCollectorToken(token.plaintext, "sha256:short"), false);
  assert.equal(verifyCollectorToken(token.plaintext, token.hash.toUpperCase()), false);
});
