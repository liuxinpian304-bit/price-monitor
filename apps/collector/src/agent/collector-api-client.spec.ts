import assert from "node:assert/strict";
import test from "node:test";

import type { CollectorClaimInput, CollectorReport } from "@stau-price-monitor/contracts";

import {
  CollectorApiClient,
  CollectorApiError,
  type CollectorFetch
} from "./collector-api-client.ts";

const token = `pmc_${"B".repeat(43)}`;
const evidenceKey = `sha256:${"a".repeat(64)}`;
const claimInput: CollectorClaimInput = {
  appVersion: "2.4.5",
  capabilities: ["accessibility", "png-evidence"],
  session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
};
const job = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-1",
  monitoredModelId: "model-1",
  searchQuery: "Sony MDR-7506",
  searchLimit: 3,
  ownShopName: "Own Shop",
  ownListings: [{
    id: "own-1",
    url: "https://item.example.test/item.htm?id=1001",
    skuText: "Black"
  }],
  rule: {
    brand: "Sony",
    standardModel: "MDR-7506",
    version: null,
    comparisonType: "BARE",
    colorComparable: false,
    effectiveAliases: ["7506"],
    excludedAliases: [],
    mustIncludeTerms: [],
    excludedTerms: []
  }
} as const;
const report: CollectorReport = {
  schemaVersion: 1,
  runId: "run-1",
  collectorId: "agent-1",
  appVersion: "2.4.5",
  startedAt: "2026-08-24T01:00:00.000Z",
  completedAt: "2026-08-24T01:01:00.000Z",
  status: "SUCCEEDED",
  searchLimit: 3,
  searchTerminationReason: "END_MARKER",
  positions: [],
  ownItems: [{
    ownListingId: "own-1",
    platformItemId: "1001",
    url: "https://item.example.test/item.htm?id=1001",
    shopName: "Own Shop",
    title: "Sony MDR-7506",
    searchRanks: [],
    skus: [{
      skuId: `sku_${"a".repeat(64)}`,
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
      capturedAt: "2026-08-24T01:00:30.000Z",
      evidenceKey: null
    }]
  }],
  competitorItems: [],
  issues: []
};

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function clientWith(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  timeoutCalls: number[] = []
) {
  const requests: RecordedRequest[] = [];
  const fetch: CollectorFetch = async (input, init = {}) => {
    const request = { url: String(input), init };
    requests.push(request);
    return handler(request);
  };
  const client = new CollectorApiClient({
    apiUrl: "https://collector.example.test",
    pairingToken: token,
    fetch,
    timeoutSignal(milliseconds) {
      timeoutCalls.push(milliseconds);
      return new AbortController().signal;
    }
  });
  return { client, requests };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("claims with Bearer authentication and validates the returned job", async () => {
  const timeoutCalls: number[] = [];
  const { client, requests } = clientWith(() => jsonResponse(job), timeoutCalls);

  assert.deepEqual(
    await client.claim(claimInput),
    job
  );
  assert.equal(requests[0]?.url, "https://collector.example.test/api/collector-agent/jobs/claim");
  assert.equal(requests[0]?.init.method, "POST");
  assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), `Bearer ${token}`);
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    appVersion: "2.4.5",
    capabilities: ["accessibility", "png-evidence"],
    session: { state: "READY", observedAt: "2026-09-09T01:30:00.000Z" }
  });
  assert.deepEqual(timeoutCalls, [15_000]);

  const malformed = clientWith(() => jsonResponse({ ...job, searchLimit: 51 })).client;
  await assert.rejects(() => malformed.claim({ ...claimInput, capabilities: [] }), {
    code: "INVALID_RESPONSE"
  });
});

test("returns null only for the claim endpoint's empty 204 contract", async () => {
  const { client } = clientWith(() => new Response(null, { status: 204 }));
  assert.equal(await client.claim({ ...claimInput, capabilities: [] }), null);
});

test("rejects malformed session observations before sending a claim request", async () => {
  const { client, requests } = clientWith(() => new Response(null, { status: 204 }));

  await assert.rejects(() => client.claim({
    ...claimInput,
    session: { state: "LOGGED_OUT", observedAt: "2026-09-09T01:30:00.000Z" }
  } as never), { code: "INVALID_REQUEST" });

  assert.equal(requests.length, 0);
});

test("accepts the assembled runtime health contract without weakening its response validation", async () => {
  const health = {
    status: "ok",
    database: "up",
    redis: "up",
    queue: "up",
    collectorAgent: "up",
    runtime: "ASSEMBLED",
    collection: { status: "NO_RUN", finishedAt: null },
    checkedAt: "2026-08-24T01:00:00.000Z"
  } as const;
  const { client, requests } = clientWith(() => jsonResponse(health));

  assert.deepEqual(await client.checkReachability(), health);
  assert.equal(requests[0]?.url, "https://collector.example.test/api/health");
  assert.equal(new Headers(requests[0]?.init.headers).has("authorization"), false);

  const unknownField = clientWith(() => jsonResponse({ ...health, unsafeExtra: true })).client;
  await assert.rejects(() => unknownField.checkReachability(), { code: "INVALID_RESPONSE" });
});

test("sends exact heartbeat, pause, graceful release, and quarantine requests to encoded run routes", async () => {
  const { client, requests } = clientWith(() => new Response(null, { status: 204 }));

  await client.heartbeat("run/encoded", { discoveredCount: 7, skuCount: 19 });
  await client.pause("run/encoded", "LOGIN_REQUIRED", "Operator login required");
  await client.release("run/encoded");
  await client.release("run/encoded", {
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  });

  assert.equal(
    requests[0]?.url,
    "https://collector.example.test/api/collector-agent/jobs/run%2Fencoded/heartbeat"
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    discoveredCount: 7,
    skuCount: 19
  });
  assert.equal(
    requests[1]?.url,
    "https://collector.example.test/api/collector-agent/jobs/run%2Fencoded/pause"
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
    code: "LOGIN_REQUIRED",
    message: "Operator login required"
  });
  assert.equal(
    requests[2]?.url,
    "https://collector.example.test/api/collector-agent/jobs/run%2Fencoded/release"
  );
  assert.equal(requests[2]?.init.body, undefined);
  assert.equal(
    requests[3]?.url,
    "https://collector.example.test/api/collector-agent/jobs/run%2Fencoded/release"
  );
  assert.deepEqual(JSON.parse(String(requests[3]?.init.body)), {
    disposition: "QUARANTINE",
    errorCode: "INVALID_CHECKPOINT"
  });
});

test("uploads PNG multipart data by hash and requires the same hash acknowledgement", async () => {
  const { client, requests } = clientWith(() => jsonResponse({ evidenceKey }, 201));
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

  assert.deepEqual(await client.uploadEvidence("run-1", evidenceKey, bytes), { evidenceKey });
  assert.equal(
    requests[0]?.url,
    `https://collector.example.test/api/collector-agent/jobs/run-1/evidence/${"a".repeat(64)}`
  );
  assert.equal(requests[0]?.init.method, "PUT");
  assert.ok(requests[0]?.init.body instanceof FormData);
  assert.ok((requests[0]?.init.body as FormData).get("evidence") instanceof Blob);

  const wrongAck = clientWith(() => jsonResponse({ evidenceKey: `sha256:${"b".repeat(64)}` }, 200)).client;
  await assert.rejects(() => wrongAck.uploadEvidence("run-1", evidenceKey, bytes), {
    code: "INVALID_RESPONSE"
  });
});

test("validates the complete-report acknowledgement contract", async () => {
  const acknowledgement = {
    runId: "run-1",
    status: "SUCCEEDED",
    positionCount: 0,
    uniqueItemCount: 0,
    skuCount: 1,
    issueCount: 0,
    ownSnapshotIds: ["own-snapshot-1"],
    competitorSnapshotIds: []
  };
  const { client, requests } = clientWith(() => jsonResponse(acknowledgement, 202));

  assert.deepEqual(await client.uploadReport("run-1", report), acknowledgement);
  assert.equal(
    requests[0]?.url,
    "https://collector.example.test/api/collector-agent/jobs/run-1/report"
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), report);
});

test("maps status failures to safe typed metadata without retaining bodies or authorization", async () => {
  for (const [status, code, transient] of [
    [401, "AUTHENTICATION_FAILED", false],
    [409, "CONFLICT", false],
    [413, "PAYLOAD_TOO_LARGE", false],
    [422, "VALIDATION_FAILED", false],
    [503, "SERVICE_UNAVAILABLE", true]
  ] as const) {
    const secretBody = `secret-response-${status}`;
    const { client } = clientWith(() => new Response(secretBody, { status }));
    const error = await client.claim({ ...claimInput, appVersion: "account-value", capabilities: [] })
      .then(() => null, (caught: unknown) => caught);

    assert.ok(error instanceof CollectorApiError);
    assert.deepEqual(
      {
        method: error.method,
        route: error.route,
        status: error.status,
        code: error.code,
        transient: error.transient
      },
      { method: "POST", route: "/api/collector-agent/jobs/claim", status, code, transient }
    );
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(secretBody), false);
    assert.equal(serialized.includes("account-value"), false);
    assert.equal(String(error.stack).includes(token), false);
    assert.equal(Object.prototype.hasOwnProperty.call(error, "cause"), false);
  }
});

test("uses timeout cancellation and converts fetch failures without retaining unsafe causes", async () => {
  const timeoutCalls: number[] = [];
  const controller = new AbortController();
  controller.abort(new Error("unsafe-local-evidence-path"));
  const client = new CollectorApiClient({
    apiUrl: "https://collector.example.test",
    pairingToken: token,
    timeoutSignal(milliseconds) {
      timeoutCalls.push(milliseconds);
      return controller.signal;
    },
    fetch: async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      throw controller.signal.reason;
    }
  });

  const error = await client.claim({ ...claimInput, capabilities: [] })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof CollectorApiError);
  assert.equal(error.code, "TIMEOUT");
  assert.deepEqual(timeoutCalls, [15_000]);
  assert.equal(JSON.stringify(error).includes("unsafe-local-evidence-path"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(error, "cause"), false);
});

for (const [kind, responseFactory] of [
  ["fake", () => ({
    status: 200,
    json: () => new Promise<never>(() => undefined)
  }) as unknown as Response],
  ["stream", () => new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })]
] as const) {
  test(`maps an aborted stalled ${kind} response body to a transient timeout`, async () => {
    const controller = new AbortController();
    const client = new CollectorApiClient({
      apiUrl: "https://collector.example.test",
      pairingToken: token,
      timeoutSignal: () => controller.signal,
      fetch: async () => responseFactory()
    });

    const pending = client.claim({ ...claimInput, capabilities: [] });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("unsafe response-body timeout detail"));
    const error = await Promise.race([
      pending.then(() => null, (caught: unknown) => caught),
      new Promise<"STALLED">((resolve) => setTimeout(() => resolve("STALLED"), 100))
    ]);

    assert.ok(error instanceof CollectorApiError);
    assert.deepEqual(
      { code: error.code, transient: error.transient, status: error.status },
      { code: "TIMEOUT", transient: true, status: null }
    );
    assert.equal(JSON.stringify(error).includes("unsafe response-body timeout detail"), false);
  });
}

test("keeps a completed malformed response body non-transient", async () => {
  const { client } = clientWith(() => new Response("{", {
    status: 200,
    headers: { "content-type": "application/json" }
  }));

  const error = await client.claim({ ...claimInput, capabilities: [] })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof CollectorApiError);
  assert.deepEqual(
    { code: error.code, transient: error.transient },
    { code: "INVALID_RESPONSE", transient: false }
  );
});

test("maps a body rejection caused by abort to a transient timeout", async () => {
  const controller = new AbortController();
  const client = new CollectorApiClient({
    apiUrl: "https://collector.example.test",
    pairingToken: token,
    timeoutSignal: () => controller.signal,
    fetch: async () => ({
      status: 200,
      json: () => new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true
        });
      })
    }) as unknown as Response
  });

  const pending = client.claim({ ...claimInput, capabilities: [] });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("unsafe body rejection detail"));
  await assert.rejects(() => pending, {
    code: "TIMEOUT",
    transient: true,
    status: null
  });
});
