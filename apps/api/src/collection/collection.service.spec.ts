import assert from "node:assert/strict";
import test from "node:test";

import {
  OfferUnavailableError,
  ProviderContractChangedError,
  ProviderRateLimitedError,
  type CommerceProvider,
  type RawOffer,
  type SearchHit
} from "./providers/commerce-provider.ts";
import {
  CollectionAlreadyRunningError,
  CollectionService,
  type CollectedOfferInput,
  type CollectionLock,
  type CollectionModel,
  type CollectionRepository,
  type CollectionSummary
} from "./collection.service.ts";
import {
  CollectionScheduler,
  type CollectionSchedule,
  type CollectionScheduleQueue
} from "./collection.scheduler.ts";
import { MatcherService } from "../matching/matcher.service.ts";
import { PriceEngineService } from "../pricing/price-engine.service.ts";

const model: CollectionModel = {
  id: "model-1",
  providerKey: "manual-fixtures",
  searchQuery: "RME Babyface Pro FS",
  rule: {
    brand: "RME",
    standardModel: "Babyface Pro FS",
    version: "FS新版",
    comparisonType: "BARE",
    effectiveAliases: ["娃娃脸FS"],
    excludedAliases: [],
    mustIncludeTerms: ["Babyface", "FS"],
    excludedTerms: ["二手", "定金", "维修"]
  }
};

const hits: SearchHit[] = [
  {
    platformItemId: "1001",
    url: "https://detail.tmall.com/item.htm?id=1001",
    shopName: "同行A",
    title: "RME Babyface Pro FS 官方标配",
    displayPriceRangeFen: { minFen: 100, maxFen: 649_900 }
  },
  {
    platformItemId: "1002",
    url: "https://detail.tmall.com/item.htm?id=1002",
    shopName: "同行B",
    title: "RME Babyface Pro FS 官方标配",
    displayPriceRangeFen: { minFen: 629_900, maxFen: 649_900 }
  }
];

function rawOffer(itemId = "1001"): RawOffer {
  return {
    platformItemId: itemId,
    url: `https://detail.tmall.com/item.htm?id=${itemId}`,
    shopName: "同行A",
    title: "RME Babyface Pro FS 官方标配",
    selectedSkuId: "sku-bare",
    skuOptions: [{
      skuId: "sku-bare",
      label: "Babyface Pro FS 单机",
      attributes: { 版本: "FS新版" },
      listPriceFen: 649_900,
      publicDiscountFen: 20_000,
      payableFen: 629_900,
      stockState: "IN_STOCK"
    }],
    listPriceFen: 649_900,
    publicDiscountFen: 20_000,
    payableFen: 629_900,
    promotions: [],
    gifts: [],
    stockState: "IN_STOCK",
    capturedAt: new Date("2026-08-19T01:30:00.000Z"),
    evidenceUrl: "https://evidence.example/1001",
    rawEvidence: { source: "fixture", itemId }
  };
}

class FakeRepository implements CollectionRepository {
  completed = new Map<string, CollectionSummary>();
  saved: CollectedOfferInput[] = [];
  itemFailures: Array<{ runId: string; url: string; message: string }> = [];
  systemErrors: Array<{ runId: string; code: string; message: string }> = [];
  finishes: Array<{ runId: string; status: string; summary: CollectionSummary }> = [];

  async getModel(id: string) {
    return id === model.id ? model : null;
  }

  async getCompletedSummary(runId: string) {
    return this.completed.get(runId) ?? null;
  }

  async startRun() {}

  async saveOffer(input: CollectedOfferInput) {
    this.saved.push(input);
  }

  async recordItemFailure(runId: string, url: string, message: string) {
    this.itemFailures.push({ runId, url, message });
  }

  async recordSystemError(runId: string, code: string, message: string) {
    this.systemErrors.push({ runId, code, message });
  }

  async finishRun(runId: string, status: string, summary: CollectionSummary) {
    this.finishes.push({ runId, status, summary });
    if (status === "SUCCEEDED" || status === "PARTIAL_FAILED") {
      this.completed.set(runId, summary);
    }
  }
}

class FakeLock implements CollectionLock {
  available = true;
  released = 0;

  async acquire() {
    return this.available ? "lock-token" : null;
  }

  async release() {
    this.released += 1;
  }
}

function service(provider: CommerceProvider, repository = new FakeRepository(), lock = new FakeLock()) {
  return {
    repository,
    lock,
    service: new CollectionService(
      repository,
      provider,
      new MatcherService(),
      new PriceEngineService(),
      lock
    )
  };
}

test("registers exactly the twelve approved Asia/Shanghai schedules", async () => {
  const schedules: CollectionSchedule[] = [];
  const queue: CollectionScheduleQueue = {
    upsertSchedule: async (schedule) => { schedules.push(schedule); }
  };

  await new CollectionScheduler(queue).registerSchedules();

  assert.equal(schedules.length, 12);
  assert.ok(schedules.every((schedule) => schedule.timeZone === "Asia/Shanghai"));
  assert.deepEqual(schedules.map((schedule) => schedule.localTime), [
    "03:30", "09:30", "10:30", "11:30", "12:30", "13:30",
    "14:30", "15:30", "16:30", "17:30", "18:30", "22:30"
  ]);
  assert.equal(schedules[0]?.pattern, "0 30 3 * * *");
});

test("continues the batch when one offer is unavailable", async () => {
  const provider: CommerceProvider = {
    search: async () => hits,
    fetchOffer: async (url) => {
      if (url.includes("1002")) throw new OfferUnavailableError("item removed");
      return rawOffer();
    }
  };
  const context = service(provider);

  const summary = await context.service.runMonitoredModel("model-1", "run-1");

  assert.deepEqual(summary, { searched: 2, fetched: 1, matched: 1, failed: 1 });
  assert.equal(context.repository.saved.length, 1);
  assert.deepEqual(context.repository.saved[0]?.offer.rawEvidence, { source: "fixture", itemId: "1001" });
  assert.equal(context.repository.itemFailures.length, 1);
  assert.equal(context.repository.finishes[0]?.status, "PARTIAL_FAILED");
  assert.equal(context.lock.released, 1);
});

test("does not run the same monitored model concurrently", async () => {
  const provider: CommerceProvider = { search: async () => [], fetchOffer: async () => rawOffer() };
  const context = service(provider);
  context.lock.available = false;

  await assert.rejects(
    context.service.runMonitoredModel("model-1", "run-1"),
    CollectionAlreadyRunningError
  );
  assert.equal(context.repository.finishes.length, 0);
});

test("returns the stored summary for an already completed runId", async () => {
  let searches = 0;
  const provider: CommerceProvider = {
    search: async () => { searches += 1; return []; },
    fetchOffer: async () => rawOffer()
  };
  const context = service(provider);
  context.repository.completed.set("run-1", { searched: 9, fetched: 8, matched: 7, failed: 1 });

  assert.deepEqual(await context.service.runMonitoredModel("model-1", "run-1"), {
    searched: 9, fetched: 8, matched: 7, failed: 1
  });
  assert.equal(searches, 0);
});

for (const error of [
  new ProviderRateLimitedError("quota reached", 120),
  new ProviderContractChangedError("missing sku_options")
]) {
  test(`records ${error.name} as a system error`, async () => {
    const provider: CommerceProvider = {
      search: async () => { throw error; },
      fetchOffer: async () => rawOffer()
    };
    const context = service(provider);

    await assert.rejects(context.service.runMonitoredModel("model-1", "run-1"), error.constructor);
    assert.equal(context.repository.systemErrors.length, 1);
    assert.equal(context.repository.finishes[0]?.status, "FAILED");
    assert.equal(context.lock.released, 1);
  });
}
