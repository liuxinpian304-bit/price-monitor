import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRuntimeLifecycle } from "./runtime-lifecycle.ts";

import { AlertActionService } from "./alerts/alert-action.service.ts";
import { AlertController } from "./alerts/alert.controller.ts";
import { PrismaAlertActionRepository } from "./alerts/prisma-alert-action.repository.ts";
import { PrismaRunAlertNotificationRepository } from "./alerts/prisma-run-alert-notification.repository.ts";
import { RunAlertNotifier } from "./alerts/run-alert-notifier.ts";
import { WecomClient } from "./alerts/wecom/wecom.client.ts";
import { AuditService } from "./audit/audit.service.ts";
import { PrismaAuditRepository } from "./audit/prisma-audit.repository.ts";
import { CatalogController } from "./catalog/catalog.controller.ts";
import { CatalogService } from "./catalog/catalog.service.ts";
import { CatalogTemplateService } from "./catalog/catalog-template.service.ts";
import { CatalogImportController } from "./catalog/import/catalog-import.controller.ts";
import { CatalogImportService } from "./catalog/import/catalog-import.service.ts";
import { PrismaCatalogImportWriter } from "./catalog/import/prisma-catalog-import.writer.ts";
import { PrismaCatalogRepository } from "./catalog/prisma-catalog.repository.ts";
import { CollectorAgentService } from "./collector-agent/collector-agent.service.ts";
import { PrismaCollectorAgentRepository } from "./collector-agent/prisma-collector-agent.repository.ts";
import { CollectionEvidenceStore } from "./collection/collection-evidence-store.ts";
import { CollectionScheduleProcessor, BullMqCollectionScheduleQueue } from "./collection/collection.processor.ts";
import {
  CollectionRunQueueService,
  PrismaCollectionRunQueueRepository
} from "./collection/collection-run-queue.service.ts";
import { CollectionScheduler } from "./collection/collection.scheduler.ts";
import { DesktopReportIngestionService } from "./collection/desktop-report-ingestion.service.ts";
import { PrismaDesktopReportRepository } from "./collection/prisma-desktop-report.repository.ts";
import { PrismaRunAlertRepository } from "./collection/prisma-run-alert.repository.ts";
import { RunAlertService } from "./collection/run-alert.service.ts";
import { createPrismaClient } from "./database/prisma.service.ts";
import { HealthService } from "./health/health.service.ts";
import {
  PrismaCollectionHealthRepository,
  PrismaCollectorAgentHealthProbe,
  PrismaDatabaseProbe,
  RedisHealthProbe
} from "./health/prisma-health.ts";
import { OperationsQueryService } from "./operations/operations-query.service.ts";
import { ManualClassificationService } from "./operations/manual-classification.service.ts";
import { PrismaManualClassificationRepository } from "./operations/prisma-manual-classification.repository.ts";
import { PrismaSettingsRepository } from "./settings/prisma-settings.repository.ts";
import { SecretStore } from "./settings/secret-store.ts";
import { SettingsService } from "./settings/settings.service.ts";
import {
  databaseUrlFromEnvironment,
  publicBaseUrlFromEnvironment,
  redisConnectionFromEnvironment,
  reportUrlForRun,
  settingsMasterKeyFromEnvironment
} from "./startup/api-startup-config.ts";

export const prisma = createPrismaClient(databaseUrlFromEnvironment());
const redisConnection = redisConnectionFromEnvironment();
export const redis = new Redis({
  host: redisConnection.host,
  port: redisConnection.port,
  maxRetriesPerRequest: null,
  lazyConnect: true
});
let runtimeLifecycle: ReturnType<typeof createRuntimeLifecycle> | null = null;
let runtimeStarted = false;
let collectionScheduler: CollectionScheduler | null = null;

async function currentScheduleSettings() {
  const settings = await settingsService.getPublicSettings("ADMIN");
  return { enabled: settings.schedulerEnabled, provider: settings.provider };
}

async function reconcileCollectionSchedules(): Promise<void> {
  if (collectionScheduler) await collectionScheduler.registerSchedules();
}


const audit = new AuditService(new PrismaAuditRepository(prisma));
export const catalogController = new CatalogController(
  new CatalogService(new PrismaCatalogRepository(prisma), audit)
);
export const catalogTemplateService = new CatalogTemplateService();
export const catalogImportController = new CatalogImportController(
  new CatalogImportService(new PrismaCatalogImportWriter(prisma))
);
export const alertController = new AlertController(
  new AlertActionService(new PrismaAlertActionRepository(prisma), audit)
);
export const settingsService = new SettingsService(
  new PrismaSettingsRepository(prisma),
  new SecretStore(settingsMasterKeyFromEnvironment()),
  audit,
  reconcileCollectionSchedules
);
export const healthService = new HealthService(
  new PrismaDatabaseProbe(prisma),
  { ping: async () => runtimeStarted },
  new PrismaCollectionHealthRepository(prisma),
  new RedisHealthProbe(redis),
  new PrismaCollectorAgentHealthProbe(prisma)
);
export const operationsQuery = new OperationsQueryService(prisma);
export const manualClassificationService = new ManualClassificationService(
  new PrismaManualClassificationRepository(prisma),
  audit
);
export const collectorAgentService = new CollectorAgentService(
  new PrismaCollectorAgentRepository(prisma)
);
export const collectionRunQueueService = new CollectionRunQueueService(
  new PrismaCollectionRunQueueRepository(prisma)
);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const collectionEvidenceStore = new CollectionEvidenceStore(
  resolve(repositoryRoot, "work/collector-evidence")
);
const publicBaseUrl = publicBaseUrlFromEnvironment();

export const runAlertService = new RunAlertService(
  new PrismaRunAlertRepository(prisma),
  (runId) => reportUrlForRun(publicBaseUrl, runId)
);
export const runAlertNotifier = new RunAlertNotifier(
  new PrismaRunAlertNotificationRepository(prisma),
  async () => {
    const webhookUrl = await settingsService.readSecretForInternalUse("WECOM_WEBHOOK");
    return webhookUrl ? new WecomClient({ webhookUrl }) : null;
  }
);
export const desktopReportIngestionService = new DesktopReportIngestionService(
  collectorAgentService,
  new PrismaDesktopReportRepository(prisma),
  collectionEvidenceStore,
  runAlertService,
  runAlertNotifier
);

function createDesktopScheduleRuntime() {
  const scheduleQueue = new Queue("desktop-collection-schedule", { connection: redis });
  const scheduleProcessor = new CollectionScheduleProcessor(collectionRunQueueService, currentScheduleSettings);
  const scheduleWorker = new Worker(
    "desktop-collection-schedule",
    async (job) => scheduleProcessor.process({ timestamp: job.timestamp }),
    { connection: redis, concurrency: 1 }
  );
  collectionScheduler = new CollectionScheduler(
    new BullMqCollectionScheduleQueue(scheduleQueue),
    currentScheduleSettings
  );
  return createRuntimeLifecycle({
    scheduler: collectionScheduler,
    worker: scheduleWorker,
    queue: scheduleQueue,
    redis,
    prisma
  });
}

export async function startRuntime(): Promise<void> {
  runtimeLifecycle ??= createDesktopScheduleRuntime();
  await runtimeLifecycle.start();
  runtimeStarted = true;
}

export async function closeRuntime(): Promise<void> {
  if (runtimeLifecycle) {
    await runtimeLifecycle.close();
    runtimeStarted = false;
    return;
  }
  if (redis.status !== "end") redis.disconnect();
  await prisma.$disconnect();
}
