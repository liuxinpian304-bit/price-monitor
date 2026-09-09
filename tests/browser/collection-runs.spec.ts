import { expect, test, type Locator, type Page } from "playwright/test";
import type { CollectionRunReportDetail } from "../../apps/web/src/api/types.ts";

const adminToken = "fixture-admin-token";
const runId = "run-fixture-001";
const capturedAt = "2026-08-25T01:30:00.000Z";

const summary = {
  id: runId,
  status: "PARTIAL_FAILED",
  provider: "taobao-desktop",
  scheduledFor: capturedAt,
  startedAt: "2026-08-25T01:30:10.000Z",
  finishedAt: "2026-08-25T01:38:00.000Z",
  model: {
    id: "model-fixture-001",
    monitorCode: "FIXTURE-AUDIO-001",
    label: "脱敏音频接口 Fixture",
    comparisonType: "BARE",
    owner: "运营测试"
  },
  collector: {
    id: "agent-fixture-001",
    name: "registered-mac-fixture",
    platform: "MACOS",
    appVersion: "0.0.0-fixture",
    sessionState: "READY",
    sessionObservedAt: capturedAt,
    sessionChangedAt: capturedAt
  },
  completion: {
    positionsCaptured: 47,
    requestedPositions: 50,
    discoveredCount: 47,
    fetchedCount: 47,
    matchedCount: 44,
    failedCount: 3,
    uniqueItemCount: 47,
    skuCount: 2,
    incompleteCount: 3,
    terminationReason: null,
    complete: false,
    label: "47 / 50，未完成"
  },
  notification: {
    state: "PENDING",
    attempts: 0,
    notifiedAt: null,
    lastError: "WECOM_FIXTURE_NOT_SENT"
  },
  error: {
    code: "SKU_ENUMERATION_INCOMPLETE",
    message: "fixture 中有 3 个位置未完成"
  }
} as const;

const pageMeta = (total: number) => ({
  page: 1,
  pageSize: 50,
  total,
  totalPages: total === 0 ? 0 : 1,
  hasPrevious: false,
  hasNext: false
});

const listFixture = {
  runs: [summary],
  pagination: { ...pageMeta(1), pageSize: 25 }
};

const detailFixture = {
  ...summary,
  positions: [{
    rank: 1,
    platformItemId: "fixture-item-001",
    url: "https://example.invalid/items/fixture-item-001",
    shopName: "脱敏同行店",
    title: "脱敏音频接口 Fixture",
    displayPriceMinFen: 69_799,
    displayPriceMaxFen: 69_799,
    sponsored: false,
    capturedAt
  }],
  issues: [{
    id: "issue-fixture-001",
    code: "SKU_ENUMERATION_INCOMPLETE",
    platformItemId: "fixture-item-001",
    skuId: null,
    message: "fixture 未完成项",
    evidenceSha256: null,
    capturedAt
  }],
  filters: {},
  businessSummary: {
    distinctShopCount: 1,
    distinctItemCount: 1,
    skuCount: 2,
    matchedSkuCount: 1,
    confirmedLowCount: 1,
    missingCombinationCount: 0,
    reviewCount: 0,
    excludedCount: 0,
    ownConfiguredListingCount: 1,
    ownCollectedListingCount: 1,
    ownCatalogComplete: true
  },
  priceBoard: { shops: [] },
  confirmedLows: [],
  missingOwnGroups: [],
  reviewRows: [],
  totalSkuCount: 2,
  pagination: {
    positions: pageMeta(1),
    issues: pageMeta(1),
    skus: pageMeta(2)
  },
  skus: [
    {
      id: "sku-own-fixture",
      source: "OWN",
      platformItemId: "fixture-own-item",
      skuId: "fixture-standard",
      shopName: "星空乐器专营店",
      title: "脱敏音频接口 Fixture",
      skuText: "标准版",
      url: "https://example.invalid/items/fixture-own-item",
      ranks: [1],
      positions: [],
      attributes: {},
      components: null,
      promotions: [],
      gifts: [],
      prices: {
        listPriceFen: 69_800,
        activityPriceFen: 69_800,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 69_800
      },
      stockState: "IN_STOCK",
      confidence: "CONFIRMED",
      match: {
        category: "EXACT",
        decision: "BARE",
        comparable: true,
        confidenceBps: 10_000,
        reasons: ["fixture 型号一致"]
      },
      combination: { state: "OWN", signature: "fixture-standard", label: "标准版", reasons: [] },
      selectedOwnSnapshot: null,
      alternativeOwnSnapshots: [],
      differenceFen: null,
      comparison: { state: "OWN", ownPayableFen: 69_800, differenceFen: null },
      evidenceSha256: "a".repeat(64),
      capturedAt
    },
    {
      id: "sku-competitor-fixture",
      source: "COMPETITOR",
      platformItemId: "fixture-item-001",
      skuId: "fixture-standard",
      shopName: "脱敏同行店",
      title: "脱敏音频接口 Fixture",
      skuText: "标准版",
      url: "https://example.invalid/items/fixture-item-001",
      ranks: [1],
      positions: [],
      attributes: {},
      components: null,
      promotions: [],
      gifts: [],
      prices: {
        listPriceFen: 69_799,
        activityPriceFen: 69_799,
        couponDiscountFen: 0,
        fullReductionFen: 0,
        directDiscountFen: 0,
        mandatoryFeeFen: 0,
        publicDiscountFen: 0,
        payableFen: 69_799
      },
      stockState: "IN_STOCK",
      confidence: "CONFIRMED",
      match: {
        category: "EXACT",
        decision: "BARE",
        comparable: true,
        confidenceBps: 10_000,
        reasons: ["fixture 型号一致"]
      },
      combination: { state: "MATCHED", signature: "fixture-standard", label: "标准版", reasons: [] },
      selectedOwnSnapshot: null,
      alternativeOwnSnapshots: [],
      differenceFen: 1,
      comparison: { state: "LOWER", ownPayableFen: 69_800, differenceFen: 1 },
      evidenceSha256: null,
      capturedAt
    }
  ]
} satisfies CollectionRunReportDetail;

async function expectContainedHorizontalScroll(wrapper: Locator): Promise<void> {
  await expect(wrapper).toBeVisible();
  await expect.poll(async () => wrapper.evaluate((element) => {
    const candidates = [element, ...element.querySelectorAll<HTMLElement>("*")];
    const containsScrollableElement = candidates.some((candidate) => {
      const style = getComputedStyle(candidate);
      return (style.overflowX === "auto" || style.overflowX === "scroll")
        && candidate.scrollWidth > candidate.clientWidth;
    });
    return getComputedStyle(element).overflowX === "auto" && containsScrollableElement;
  })).toBe(true);
}

async function expectNoBodyOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    body: document.body.scrollWidth <= document.body.clientWidth,
    document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
  }))).toEqual({ body: true, document: true });
}

test("ADMIN unlock recovers run list once and report tables stay contained", async ({ page }) => {
  const consoleErrors: string[] = [];
  const authorizedListHeaders: string[] = [];
  let documentRequests = 0;

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests += 1;
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers().authorization;

    if (url.pathname === "/api/health") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          database: "up",
          redis: "up",
          queue: "up",
          collectorAgent: "up",
          runtime: "ASSEMBLED"
        })
      });
      return;
    }

    if (url.pathname === "/api/operations/collection-runs") {
      if (authorization !== `Bearer ${adminToken}`) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "fixture requires ADMIN unlock" })
        });
        return;
      }
      authorizedListHeaders.push(authorization);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listFixture) });
      return;
    }

    if (url.pathname === `/api/operations/collection-runs/${runId}`) {
      if (authorization !== `Bearer ${adminToken}`) {
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "forbidden" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detailFixture) });
      return;
    }

    if (url.pathname === `/api/operations/collection-runs/${runId}/evidence/${"a".repeat(64)}`) {
      if (authorization !== `Bearer ${adminToken}`) {
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "forbidden" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "fixture route not found" }) });
  });

  await page.goto("/runs");
  await expect(page.getByRole("dialog", { name: "解锁管理员操作" })).toBeVisible();
  await page.getByLabel("管理员凭证").fill(adminToken);
  await page.getByRole("dialog", { name: "解锁管理员操作" }).getByRole("button", { name: /解\s*锁/ }).click();

  await expect(page.getByRole("link", { name: summary.model.label }).first()).toBeVisible();
  expect(authorizedListHeaders).toEqual([`Bearer ${adminToken}`]);
  expect(documentRequests).toBe(1);
  await expectNoBodyOverflow(page);
  await expectContainedHorizontalScroll(page.getByTestId("collection-runs-scroll"));

  await page.getByRole("link", { name: summary.model.label }).first().click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
  await expect(page.getByText("47 / 50，未完成").first()).toBeVisible();
  await expectNoBodyOverflow(page);
  await expectContainedHorizontalScroll(page.getByTestId("collection-run-positions-scroll"));
  await expectContainedHorizontalScroll(page.getByTestId("collection-run-skus-scroll"));

  const popupPromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "查看证据" }).first().click();
  const evidencePage = await popupPromise;
  await expect.poll(() => evidencePage.url()).toMatch(/^blob:/);
  await expect(evidencePage.locator("img")).toBeVisible();
  await evidencePage.close();

  const filterControls = page.locator(".run-filter-tools .ant-select");
  await expect(filterControls).toHaveCount(4);
  const overlaps = await filterControls.evaluateAll((elements) => elements.flatMap((element, index) => {
    const first = element.getBoundingClientRect();
    return elements.slice(index + 1).filter((candidate) => {
      const second = candidate.getBoundingClientRect();
      return first.left < second.right && first.right > second.left
        && first.top < second.bottom && first.bottom > second.top;
    }).map((candidate) => `${element.textContent}:${candidate.textContent}`);
  }));
  expect(overlaps).toEqual([]);
  const expectedAuthorizationErrors = consoleErrors.filter((entry) => entry.includes("403 (Forbidden)"));
  const unexpectedConsoleErrors = consoleErrors.filter((entry) => !entry.includes("403 (Forbidden)"));
  expect(expectedAuthorizationErrors).toHaveLength(1);
  expect(unexpectedConsoleErrors).toEqual([]);
});
