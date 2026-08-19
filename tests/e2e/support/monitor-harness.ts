import ExcelJS from "exceljs";

import {
  AlertService,
  type AlertEvaluationDecision,
  type AlertOffer,
  type AlertRepository,
  type PriceAlertNotifier,
  type PriceAlertRecord
} from "../../../apps/api/src/alerts/alert.service.ts";
import {
  CatalogImportService,
  type CatalogImportResult,
  type CatalogImportWriter,
  type ValidatedCatalogImport,
  type ValidatedModelImport
} from "../../../apps/api/src/catalog/import/catalog-import.service.ts";
import {
  CollectionService,
  type CollectedOfferInput,
  type CollectionLock,
  type CollectionModel,
  type CollectionRepository,
  type CollectionSummary
} from "../../../apps/api/src/collection/collection.service.ts";
import { ManualImportProvider } from "../../../apps/api/src/collection/providers/manual/manual-import.provider.ts";
import { MatcherService } from "../../../apps/api/src/matching/matcher.service.ts";
import { bundleSignature, type BundleComparableItem } from "../../../apps/api/src/pricing/bundle-signature.ts";
import { PriceEngineService } from "../../../apps/api/src/pricing/price-engine.service.ts";

const MODEL_HEADERS = [
  "监控编号", "是否启用", "品牌", "标准型号", "类目", "搜索关键词", "型号版本", "必须包含词",
  "排除词", "我方商品链接", "我方SKU规格", "比价类型", "套装编号", "颜色是否可互比", "负责人", "备注"
];
const BUNDLE_HEADERS = [
  "套装编号", "主产品品牌", "主产品型号", "配件类型", "配件品牌", "配件型号或名称", "数量",
  "单件标准价值", "是否核心配件", "备注"
];
const ALIAS_HEADERS = ["品牌", "标准型号", "常见写法", "匹配类型", "备注"];

interface CollectOptions {
  monitorCode: "MON-0001" | "MON-0002";
  ownPriceFen: number;
  competitorPriceFen: number;
  competitorBundleModel?: "MK4" | "MK8";
}

class RecordingCatalogWriter implements CatalogImportWriter {
  catalog: ValidatedCatalogImport | null = null;

  async importAtomically(catalog: ValidatedCatalogImport) {
    this.catalog = catalog;
    return { imported: catalog.models.length, updated: 0 };
  }
}

class InMemoryAlertRepository implements AlertRepository {
  readonly alerts: PriceAlertRecord[] = [];
  readonly notificationFailures: Array<{ alertId: string; message: string }> = [];

  async findByDedupKey(key: string) {
    return this.alerts.find((alert) => alert.dedupKey === key) ?? null;
  }

  async create(input: Omit<PriceAlertRecord, "id" | "notifiedAt">) {
    const alert: PriceAlertRecord = {
      ...input,
      id: `acceptance-alert-${this.alerts.length + 1}`,
      notifiedAt: null
    };
    this.alerts.push(alert);
    return alert;
  }

  async markNotified(id: string, notifiedAt: Date) {
    const alert = this.alerts.find((item) => item.id === id);
    if (alert) {
      alert.notifiedAt = notifiedAt;
    }
  }

  async recordNotificationFailure(alertId: string, message: string) {
    this.notificationFailures.push({ alertId, message });
  }
}

class RecordingNotifier implements PriceAlertNotifier {
  readonly sent: PriceAlertRecord[] = [];

  async sendPriceAlert(alert: PriceAlertRecord) {
    this.sent.push(alert);
  }
}

class AvailableLock implements CollectionLock {
  async acquire() {
    return "acceptance-lock";
  }

  async release() {}
}

function selectedSkuText(input: CollectedOfferInput): string {
  return input.offer.skuOptions.find((sku) => sku.skuId === input.offer.selectedSkuId)?.label ?? input.offer.title;
}

function importedBundleItems(catalog: ValidatedCatalogImport, code: string): BundleComparableItem[] {
  const bundle = catalog.bundles.find((item) => item.code === code);
  if (!bundle) {
    throw new Error(`Acceptance bundle ${code} was not imported`);
  }
  return bundle.items.map((item) => ({
    accessoryType: item.accessoryType,
    brand: item.accessoryBrand,
    modelOrName: item.modelOrName,
    quantity: item.quantity,
    unitValueFen: item.unitValueFen,
    core: item.core
  }));
}

function bundleDecision(
  input: CollectedOfferInput,
  catalog: ValidatedCatalogImport,
  model: ValidatedModelImport,
  competitorBundleModel: "MK4" | "MK8" | undefined
): AlertEvaluationDecision {
  if (model.comparisonType === "BARE") {
    return {
      category: input.match.category,
      comparable: input.match.comparable,
      bundleConfiguration: "NOT_APPLICABLE",
      reasons: input.match.reasons
    };
  }

  const ownSignature = bundleSignature(importedBundleItems(catalog, model.bundleCode!));
  const competitorSignature = bundleSignature([{
    accessoryType: "麦克风",
    brand: "Sennheiser",
    modelOrName: competitorBundleModel ?? "MK4",
    quantity: 1,
    unitValueFen: 180_000,
    core: true
  }]);
  const sameConfiguration = ownSignature === competitorSignature;
  return {
    category: input.match.category,
    comparable: input.match.comparable && sameConfiguration,
    bundleConfiguration: sameConfiguration ? "SAME" : "DIFFERENT",
    reasons: [
      ...input.match.reasons,
      sameConfiguration ? "核心配件配置完全相同" : "核心配件配置不同，转人工核对"
    ]
  };
}

class PipelineCollectionRepository implements CollectionRepository {
  private readonly collectionModel: CollectionModel;
  private readonly importedModel: ValidatedModelImport;
  private readonly catalog: ValidatedCatalogImport;
  private readonly ownPriceFen: number;
  private readonly competitorBundleModel: "MK4" | "MK8" | undefined;
  private readonly alertService: AlertService;

  constructor(input: {
    collectionModel: CollectionModel;
    importedModel: ValidatedModelImport;
    catalog: ValidatedCatalogImport;
    ownPriceFen: number;
    competitorBundleModel: "MK4" | "MK8" | undefined;
    alertService: AlertService;
  }) {
    this.collectionModel = input.collectionModel;
    this.importedModel = input.importedModel;
    this.catalog = input.catalog;
    this.ownPriceFen = input.ownPriceFen;
    this.competitorBundleModel = input.competitorBundleModel;
    this.alertService = input.alertService;
  }

  async getModel(id: string) {
    return id === this.collectionModel.id ? this.collectionModel : null;
  }

  async getCompletedSummary() {
    return null;
  }

  async startRun() {}

  async saveOffer(input: CollectedOfferInput) {
    const ownOffer: AlertOffer = {
      monitoredModelId: this.collectionModel.id,
      snapshotId: `${input.runId}-own`,
      platformItemId: `own-${this.importedModel.monitorCode}`,
      skuId: `own-sku-${this.importedModel.monitorCode}`,
      brand: this.importedModel.brand,
      standardModel: this.importedModel.standardModel,
      comparisonType: this.importedModel.comparisonType,
      shopName: "星空乐器专营店",
      skuText: this.importedModel.ownSkuText,
      payableFen: this.ownPriceFen,
      url: this.importedModel.ownUrl,
      capturedAt: input.offer.capturedAt,
      owner: this.importedModel.owner
    };
    const competitorOffer: AlertOffer = {
      monitoredModelId: this.collectionModel.id,
      snapshotId: `${input.runId}-competitor`,
      platformItemId: input.offer.platformItemId,
      skuId: input.offer.selectedSkuId,
      brand: this.importedModel.brand,
      standardModel: this.importedModel.standardModel,
      comparisonType: this.importedModel.comparisonType,
      shopName: input.offer.shopName,
      skuText: selectedSkuText(input),
      payableFen: input.price.payableFen,
      url: input.offer.url,
      capturedAt: input.offer.capturedAt,
      owner: this.importedModel.owner
    };

    await this.alertService.evaluate(
      ownOffer,
      competitorOffer,
      bundleDecision(input, this.catalog, this.importedModel, this.competitorBundleModel)
    );
  }

  async recordItemFailure() {}

  async recordSystemError() {}

  async finishRun(_runId: string, _status: "SUCCEEDED" | "PARTIAL_FAILED" | "FAILED", _summary: CollectionSummary) {}
}

function yuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

function providerFixture(model: ValidatedModelImport, options: CollectOptions, runNumber: number) {
  const bundleModel = options.competitorBundleModel ?? "MK4";
  const platformItemId = `competitor-${model.monitorCode}`;
  const url = `https://detail.tmall.com/item.htm?id=${platformItemId}`;
  const skuId = `competitor-sku-${model.monitorCode}`;
  const title = model.comparisonType === "BARE"
    ? "RME Babyface Pro FS 专业声卡 官方标配"
    : `RME Babyface Pro FS ${bundleModel}录音套装`;
  const skuLabel = model.comparisonType === "BARE"
    ? "Babyface Pro FS 单机"
    : `Babyface Pro FS+${bundleModel}套装`;
  const attributes = model.comparisonType === "BARE"
    ? { 版本: "FS新版" }
    : { 声卡: "Babyface Pro FS", 麦克风: bundleModel };
  const capturedAt = new Date(Date.UTC(2026, 7, 19, 1, 30, runNumber)).toISOString();

  return new ManualImportProvider({
    searchResponse: {
      status: "ok",
      data: {
        items: [{
          item_id: platformItemId,
          url,
          shop_name: "同行专业音频店",
          title,
          price_range: { min_yuan: yuan(options.competitorPriceFen), max_yuan: yuan(options.competitorPriceFen) }
        }]
      }
    },
    offersByUrl: new Map([[url, {
      status: "ok",
      data: {
        item_id: platformItemId,
        url,
        shop_name: "同行专业音频店",
        title,
        selected_sku_id: skuId,
        sku_options: [{
          sku_id: skuId,
          label: skuLabel,
          attributes,
          list_price_yuan: yuan(options.competitorPriceFen),
          public_discount_yuan: "0.00",
          payable_yuan: yuan(options.competitorPriceFen),
          stock: "in_stock"
        }],
        promotions: [],
        gifts: [],
        captured_at: capturedAt,
        evidence_url: `https://evidence.example/${platformItemId}/${skuId}`
      }
    }]])
  });
}

function collectionModel(catalog: ValidatedCatalogImport, model: ValidatedModelImport): CollectionModel {
  const aliases = catalog.aliases.filter((alias) =>
    alias.brand === model.brand && alias.standardModel === model.standardModel
  );
  return {
    id: model.monitorCode,
    providerKey: "acceptance-fixture",
    searchQuery: model.searchQuery,
    rule: {
      brand: model.brand,
      standardModel: model.standardModel,
      version: model.version,
      comparisonType: model.comparisonType,
      effectiveAliases: aliases.filter((alias) => alias.type === "EFFECTIVE").map((alias) => alias.phrase),
      excludedAliases: aliases.filter((alias) => alias.type === "EXCLUDED").map((alias) => alias.phrase),
      mustIncludeTerms: model.mustIncludeTerms,
      excludedTerms: model.excludedTerms
    }
  };
}

async function catalogWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const modelSheet = workbook.addWorksheet("监控型号");
  const bundleSheet = workbook.addWorksheet("套装明细");
  const aliasSheet = workbook.addWorksheet("型号别名");
  workbook.addWorksheet("填写说明");
  modelSheet.getRow(4).values = MODEL_HEADERS;
  bundleSheet.getRow(4).values = BUNDLE_HEADERS;
  aliasSheet.getRow(4).values = ALIAS_HEADERS;
  modelSheet.getRow(5).values = [
    "MON-0001", "是", "RME", "Babyface Pro FS", "声卡", "RME Babyface Pro FS", "FS新版",
    "Babyface;FS", "二手;租赁;定金;维修;旧款", "https://detail.tmall.com/item.htm?id=own-bare",
    "Babyface Pro FS单机", "裸机", "", "否", "张三", "验收裸机"
  ];
  modelSheet.getRow(6).values = [
    "MON-0002", "是", "RME", "Babyface Pro FS", "声卡", "RME Babyface Pro FS 套装", "FS新版",
    "Babyface;FS", "二手;租赁;定金;维修;旧款", "https://detail.tmall.com/item.htm?id=own-bundle",
    "Babyface Pro FS+MK4套装", "套装", "PKG-RME-001", "否", "张三", "验收套装"
  ];
  bundleSheet.getRow(5).values = [
    "PKG-RME-001", "RME", "Babyface Pro FS", "麦克风", "Sennheiser", "MK4", "1", "1800.00", "是", ""
  ];
  aliasSheet.getRow(5).values = ["RME", "Babyface Pro FS", "娃娃脸FS", "有效别名", ""];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function createMonitorHarness() {
  const catalogWriter = new RecordingCatalogWriter();
  const importResult = await new CatalogImportService(catalogWriter).importWorkbook(
    await catalogWorkbook(),
    "acceptance-operator"
  );
  if (!catalogWriter.catalog || importResult.errors.length > 0) {
    throw new Error(`Acceptance catalog import failed: ${JSON.stringify(importResult.errors)}`);
  }

  const catalog = catalogWriter.catalog;
  const alertRepository = new InMemoryAlertRepository();
  const notifier = new RecordingNotifier();
  const alertService = new AlertService(alertRepository, notifier);
  let runNumber = 0;

  return {
    importResult: importResult as CatalogImportResult,
    alerts: alertRepository.alerts,
    notifications: notifier.sent,
    async collect(options: CollectOptions) {
      runNumber += 1;
      const importedModel = catalog.models.find((model) => model.monitorCode === options.monitorCode);
      if (!importedModel) {
        throw new Error(`Acceptance model ${options.monitorCode} was not imported`);
      }
      const model = collectionModel(catalog, importedModel);
      const repository = new PipelineCollectionRepository({
        collectionModel: model,
        importedModel,
        catalog,
        ownPriceFen: options.ownPriceFen,
        competitorBundleModel: options.competitorBundleModel,
        alertService
      });
      const service = new CollectionService(
        repository,
        providerFixture(importedModel, options, runNumber),
        new MatcherService(),
        new PriceEngineService(),
        new AvailableLock()
      );
      return service.runMonitoredModel(model.id, `acceptance-run-${runNumber}`);
    }
  };
}
