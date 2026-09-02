import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadCollectorConfig, summarizeCollectorConfig } from "./collector-config.ts";

const token = `pmc_${"A".repeat(43)}`;
const pairingTokenName = ["COLLECTOR", "PAIRING", "TOKEN"].join("_");

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    COLLECTOR_API_URL: "http://127.0.0.1:4100",
    [pairingTokenName]: token,
    COLLECTOR_NAME: "mac-studio-collector",
    TAOBAO_AX_HELPER_PATH: "apps/collector-macos/.build/debug/taobao-ax-helper",
    COLLECTOR_WORK_DIR: "work/collector-runs",
    ...overrides
  };
}

test("accepts canonical loopback HTTP and non-loopback HTTPS origins", () => {
  assert.equal(
    loadCollectorConfig(environment({ COLLECTOR_API_URL: "http://127.0.0.1:4100" })).apiUrl,
    "http://127.0.0.1:4100"
  );
  assert.equal(
    loadCollectorConfig(environment({ COLLECTOR_API_URL: "http://localhost:4100" })).apiUrl,
    "http://127.0.0.1:4100"
  );
  assert.equal(
    loadCollectorConfig(environment({ COLLECTOR_API_URL: "http://[::1]:4100" })).apiUrl,
    "http://[::1]:4100"
  );
  assert.equal(
    loadCollectorConfig(environment({ COLLECTOR_API_URL: "https://collector.example.test" })).apiUrl,
    "https://collector.example.test"
  );
});

test("rejects insecure remote and deceptive loopback HTTP authorities", () => {
  for (const apiUrl of [
    "http://192.168.1.8:4100",
    "http://collector.example.test",
    "http://localhost.example.test:4100",
    "http://localhost.:4100",
    "http://127.0.0.1.example.test:4100",
    "http://127.1:4100",
    "http://2130706433:4100",
    "http://0x7f000001:4100",
    "http://0177.0.0.1:4100",
    "http://user@127.0.0.1:4100",
    "http://127.0.0.1@collector.example.test:4100"
  ]) {
    assert.throws(
      () => loadCollectorConfig(environment({ COLLECTOR_API_URL: apiUrl })),
      /COLLECTOR_API_URL/
    );
  }
});

test("requires the exact 32-byte base64url pairing-token shape", () => {
  for (const pairingToken of [
    "",
    `pmc_${"A".repeat(42)}`,
    `pmc_${"A".repeat(44)}`,
    `pmc_${"A".repeat(42)}+`,
    `other_${"A".repeat(43)}`
  ]) {
    assert.throws(
      () => loadCollectorConfig(environment({ [pairingTokenName]: pairingToken })),
      /COLLECTOR_PAIRING_TOKEN/
    );
  }
});

test("resolves the run work directory strictly beneath the collector root", () => {
  const collectorRoot = resolve("/tmp/collector-config-root");
  const config = loadCollectorConfig(environment(), { collectorRoot });

  assert.equal(config.collectorRoot, collectorRoot);
  assert.equal(config.workDir, resolve(collectorRoot, "work/collector-runs"));

  for (const workDir of [".", "..", "../outside", "/tmp/outside"]) {
    assert.throws(
      () => loadCollectorConfig(environment({ COLLECTOR_WORK_DIR: workDir }), { collectorRoot }),
      /COLLECTOR_WORK_DIR/
    );
  }
});

test("formats only fixed-key non-secret configuration summaries", () => {
  const config = loadCollectorConfig(environment());
  const summary = summarizeCollectorConfig(config);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(Object.keys(summary).sort(), [
    "apiProtocol",
    "event",
    "helperConfigured",
    "workDirectoryConfigured"
  ]);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(config.collectorName), false);
  assert.equal(serialized.includes(config.helperPath), false);
  assert.equal(serialized.includes(config.workDir), false);
});
