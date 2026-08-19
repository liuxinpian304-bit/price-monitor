import "dotenv/config";
import { Redis } from "ioredis";

import { AlertActionService } from "./alerts/alert-action.service.ts";
import { AlertController } from "./alerts/alert.controller.ts";
import { PrismaAlertActionRepository } from "./alerts/prisma-alert-action.repository.ts";
import { AuditService } from "./audit/audit.service.ts";
import { PrismaAuditRepository } from "./audit/prisma-audit.repository.ts";
import { CatalogController } from "./catalog/catalog.controller.ts";
import { CatalogService } from "./catalog/catalog.service.ts";
import { CatalogTemplateService } from "./catalog/catalog-template.service.ts";
import { CatalogImportController } from "./catalog/import/catalog-import.controller.ts";
import { CatalogImportService } from "./catalog/import/catalog-import.service.ts";
import { PrismaCatalogImportWriter } from "./catalog/import/prisma-catalog-import.writer.ts";
import { PrismaCatalogRepository } from "./catalog/prisma-catalog.repository.ts";
import { createPrismaClient } from "./database/prisma.service.ts";
import { HealthService } from "./health/health.service.ts";
import {
  PrismaCollectionHealthRepository,
  PrismaDatabaseProbe,
  RedisHealthProbe
} from "./health/prisma-health.ts";
import { OperationsQueryService } from "./operations/operations-query.service.ts";
import { ManualClassificationService } from "./operations/manual-classification.service.ts";
import { PrismaManualClassificationRepository } from "./operations/prisma-manual-classification.repository.ts";
import { PrismaSettingsRepository } from "./settings/prisma-settings.repository.ts";
import { SecretStore } from "./settings/secret-store.ts";
import { SettingsService } from "./settings/settings.service.ts";

function settingsMasterKey(): string {
  const configured = process.env.SETTINGS_MASTER_KEY?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SETTINGS_MASTER_KEY is required in production");
  }
  return "local-development-key-change-before-production";
}

export const prisma = createPrismaClient();
export const redis = new Redis({
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6380),
  maxRetriesPerRequest: 1,
  lazyConnect: true
});

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
  new SecretStore(settingsMasterKey()),
  audit
);
export const healthService = new HealthService(
  new PrismaDatabaseProbe(prisma),
  new RedisHealthProbe(redis),
  new PrismaCollectionHealthRepository(prisma)
);
export const operationsQuery = new OperationsQueryService(prisma);
export const manualClassificationService = new ManualClassificationService(
  new PrismaManualClassificationRepository(prisma),
  audit
);

export async function closeRuntime(): Promise<void> {
  await prisma.$disconnect();
  if (redis.status !== "end") {
    redis.disconnect();
  }
}
