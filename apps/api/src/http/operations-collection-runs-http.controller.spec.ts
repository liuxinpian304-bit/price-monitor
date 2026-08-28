import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import type { Response } from "express";

import { ROLES_METADATA_KEY } from "../auth/roles.guard.ts";
import {
  COLLECTION_EVIDENCE_STORE,
  COLLECTION_REPORT_QUERY_SERVICE,
  OperationsCollectionRunsHttpController,
  type CollectionEvidenceReader,
  type CollectionRunsOperationsService
} from "./operations-collection-runs-http.controller.ts";
import type {
  CollectionReportPaginationInput,
  CollectionRunDetailPaginationInput,
  CollectionRunReportDetail,
  CollectionRunReportFilters
} from "../operations/collection-report-query.service.ts";

class QueryService implements CollectionRunsOperationsService {
  referenced = false;
  listInput: CollectionReportPaginationInput | undefined;
  detailInput: {
    runId: string;
    filters: CollectionRunReportFilters;
    pagination: CollectionRunDetailPaginationInput;
  } | undefined;
  detailResult: CollectionRunReportDetail | null = null;

  async listRuns(input?: CollectionReportPaginationInput) {
    this.listInput = input;
    return {
      runs: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0, hasPrevious: false, hasNext: false }
    };
  }
  async getRun(
    runId: string,
    filters: CollectionRunReportFilters = {},
    pagination: CollectionRunDetailPaginationInput = {}
  ) {
    this.detailInput = { runId, filters, pagination };
    return this.detailResult;
  }
  async isEvidenceReferenced() { return this.referenced; }
}

class EvidenceStore implements CollectionEvidenceReader {
  calls: Array<{ runId: string; sha256: string }> = [];
  result: Buffer | null = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  async read(runId: string, sha256: string) {
    this.calls.push({ runId, sha256 });
    return this.result;
  }
}

function response() {
  const headers = new Map<string, string>();
  const state = { body: null as Buffer | null };
  const fake = {
    headers,
    get body() { return state.body; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); return fake; },
    type(value: string) { headers.set("content-type", value); return fake; },
    send(value: Buffer) { state.body = value; return fake; }
  };
  return fake as unknown as Response & { headers: Map<string, string>; body: Buffer | null };
}

test("declares ADMIN-only operations report and evidence routes", () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, OperationsCollectionRunsHttpController), "operations/collection-runs");
  assert.deepEqual(Reflect.getMetadata(ROLES_METADATA_KEY, OperationsCollectionRunsHttpController), ["ADMIN"]);
  assert.equal(COLLECTION_REPORT_QUERY_SERVICE.description, "collection-report-query-service");
  assert.equal(COLLECTION_EVIDENCE_STORE.description, "collection-evidence-store");
});

test("passes bounded list and detail pagination to the query service", async () => {
  const query = new QueryService();
  const controller = new OperationsCollectionRunsHttpController(query, new EvidenceStore());
  query.detailResult = {} as CollectionRunReportDetail;

  await controller.list({ page: "2", pageSize: "100" });
  await controller.detail("run-1", {
    source: "COMPETITOR",
    match: "EXACT",
    price: "LOWER",
    confidence: "CONFIRMED",
    combinationState: "MATCHED",
    positionPage: "2",
    positionPageSize: "20",
    issuePage: "3",
    issuePageSize: "30",
    skuPage: "4",
    skuPageSize: "40"
  });

  assert.deepEqual(query.listInput, { page: 2, pageSize: 100 });
  assert.deepEqual(query.detailInput, {
    runId: "run-1",
    filters: {
      source: "COMPETITOR",
      match: "EXACT",
      price: "LOWER",
      confidence: "CONFIRMED",
      combinationState: "MATCHED"
    },
    pagination: {
      positionPage: 2,
      positionPageSize: 20,
      issuePage: 3,
      issuePageSize: 30,
      skuPage: 4,
      skuPageSize: 40
    }
  });
});

test("rejects invalid or oversized report pagination at the HTTP boundary", async () => {
  const controller = new OperationsCollectionRunsHttpController(new QueryService(), new EvidenceStore());

  assert.throws(() => controller.list({ page: "0" }), BadRequestException);
  assert.throws(() => controller.list({ pageSize: "101" }), BadRequestException);
  await assert.rejects(() => controller.detail("run-1", { skuPage: "1.5" }), BadRequestException);
  await assert.rejects(() => controller.detail("run-1", { issuePageSize: ["50"] }), BadRequestException);
  await assert.rejects(() => controller.detail("run-1", { combinationState: "LEGACY" }), BadRequestException);
});

test("accepts every persisted combination state filter", async () => {
  for (const combinationState of ["OWN", "MATCHED", "MISSING_OWN", "REVIEW", "EXCLUDED"] as const) {
    const query = new QueryService();
    query.detailResult = {} as CollectionRunReportDetail;
    const controller = new OperationsCollectionRunsHttpController(query, new EvidenceStore());

    await controller.detail("run-1", { combinationState });

    assert.equal(query.detailInput?.filters.combinationState, combinationState);
  }
});

test("rejects malformed evidence before repository or storage work", async () => {
  const query = new QueryService();
  const store = new EvidenceStore();
  const controller = new OperationsCollectionRunsHttpController(query, store);

  await assert.rejects(
    () => controller.evidence("run-1", "../" + "a".repeat(64), response()),
    BadRequestException
  );
  assert.equal(store.calls.length, 0);
});

test("verifies evidence ownership before reading and serves only private PNG bytes", async () => {
  const query = new QueryService();
  const store = new EvidenceStore();
  const controller = new OperationsCollectionRunsHttpController(query, store);
  const reply = response();
  const hash = "a".repeat(64);

  await assert.rejects(() => controller.evidence("run-1", hash, reply), NotFoundException);
  assert.equal(store.calls.length, 0);

  query.referenced = true;
  await controller.evidence("run-1", hash, reply);
  assert.deepEqual(store.calls, [{ runId: "run-1", sha256: hash }]);
  assert.equal(reply.headers.get("content-type"), "image/png");
  assert.equal(reply.headers.get("cache-control"), "private, no-store");
  assert.ok(reply.body);
});
