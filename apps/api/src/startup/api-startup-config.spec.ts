import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { apiStartupConfigFromEnvironment } from "./api-startup-config.ts";

const strongToken = randomBytes(32).toString("hex");

function withAdminCredential(
  environment: NodeJS.ProcessEnv,
  value: string | undefined
): NodeJS.ProcessEnv {
  return { ...environment, ["ADMIN_API_TOKEN"]: value };
}

test("production startup requires a random 256-bit hexadecimal administrator token", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app",
    SETTINGS_MASTER_KEY: "test-production-settings-key",
    PUBLIC_BASE_URL: "https://price-monitor.example.test"
  };

  const rejectedTokens = [
    undefined,
    "   ",
    "weak-token",
    "a".repeat(64),
    "0123456789".repeat(7).slice(0, 64),
    "0123456789abcdef".repeat(4),
    "abcdefghij".repeat(7).slice(0, 64),
    "deadbeef".repeat(8),
    "abcdef0123".repeat(7).slice(0, 64),
    "0123456789abcdef0".repeat(4).slice(0, 64),
    "0123456789abcdef0fedcba98765432".repeat(3).slice(0, 64),
    "0123456789abcdeffedcba9876543210".repeat(2)
  ];

  for (const ADMIN_API_TOKEN of rejectedTokens) {
    let caught: unknown;
    try {
      apiStartupConfigFromEnvironment(withAdminCredential(base, ADMIN_API_TOKEN));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /ADMIN_API_TOKEN/);
    assert.equal(caught.message.includes(ADMIN_API_TOKEN?.trim() || "not-present"), false);
  }

  const config = apiStartupConfigFromEnvironment(withAdminCredential(base, strongToken));
  assert.equal(config.adminPrincipal.adminToken, strongToken);
});

test("production accepts random 32-byte hexadecimal administrator tokens", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app",
    SETTINGS_MASTER_KEY: "test-production-settings-key",
    PUBLIC_BASE_URL: "https://price-monitor.example.test"
  };

  for (let sample = 0; sample < 10_000; sample += 1) {
    const ADMIN_API_TOKEN = randomBytes(32).toString("hex");
    const config = apiStartupConfigFromEnvironment(withAdminCredential(base, ADMIN_API_TOKEN));
    assert.equal(config.adminPrincipal.adminToken, ADMIN_API_TOKEN);
  }
});

test("production-only checks use one trimmed case-insensitive NODE_ENV value", () => {
  const base = {
    DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app",
    SETTINGS_MASTER_KEY: "test-production-settings-key",
    PUBLIC_BASE_URL: "https://price-monitor.example.test"
  };

  for (const NODE_ENV of [" production ", "PRODUCTION", "PrOdUcTiOn"]) {
    assert.throws(
      () => apiStartupConfigFromEnvironment({ ...base, NODE_ENV }),
      /ADMIN_API_TOKEN is required/
    );
    assert.throws(
      () => apiStartupConfigFromEnvironment({
        ...base,
        NODE_ENV,
        ADMIN_API_TOKEN: strongToken,
        API_HOST: "0.0.0.0"
      }),
      /ALLOW_PRIVATE_NETWORK_API/
    );
    assert.throws(
      () => apiStartupConfigFromEnvironment({
        ...base,
        NODE_ENV,
        ADMIN_API_TOKEN: strongToken,
        SETTINGS_MASTER_KEY: " "
      }),
      /SETTINGS_MASTER_KEY/
    );
  }
});

test("development may start without an administrator token but keeps admin access disabled", () => {
  const config = apiStartupConfigFromEnvironment({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app"
  });

  assert.equal(config.adminPrincipal.adminToken, null);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4100);
  assert.equal(config.collectorReportJsonLimit, 8 * 1024 * 1024);
  assert.equal(config.publicBaseUrl, "http://127.0.0.1:4100/");
});

test("startup configuration validates bind, ports, report limit, public URL and required runtime secrets", () => {
  const base = withAdminCredential({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app",
    SETTINGS_MASTER_KEY: "test-production-settings-key",
    PUBLIC_BASE_URL: "https://price-monitor.example.test"
  }, strongToken);

  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, API_HOST: "0.0.0.0" }),
    /ALLOW_PRIVATE_NETWORK_API/
  );
  assert.doesNotThrow(() => apiStartupConfigFromEnvironment({
    ...base,
    API_HOST: "0.0.0.0",
    ALLOW_PRIVATE_NETWORK_API: "true"
  }));
  assert.throws(() => apiStartupConfigFromEnvironment({ ...base, API_PORT: "nope" }), /API_PORT/);
  assert.throws(() => apiStartupConfigFromEnvironment({ ...base, REDIS_PORT: "70000" }), /REDIS_PORT/);
  assert.throws(() => apiStartupConfigFromEnvironment({ ...base, REDIS_HOST: " " }), /REDIS_HOST/);
  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, COLLECTOR_REPORT_JSON_LIMIT: "100mb" }),
    /COLLECTOR_REPORT_JSON_LIMIT/
  );
  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, PUBLIC_BASE_URL: "http://price-monitor.example.test" }),
    /PUBLIC_BASE_URL/
  );
  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, SETTINGS_MASTER_KEY: " " }),
    /SETTINGS_MASTER_KEY/
  );
  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, DATABASE_URL: " " }),
    /DATABASE_URL/
  );
  assert.throws(
    () => apiStartupConfigFromEnvironment({ ...base, DATABASE_URL: "not-a-postgresql-url" }),
    /DATABASE_URL/
  );
});
