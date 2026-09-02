import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";

import { RolesGuard } from "./auth/roles.guard.ts";
import { AlertsHttpController } from "./http/alerts-http.controller.ts";
import { CatalogHttpController } from "./http/catalog-http.controller.ts";
import {
  COLLECTOR_AGENT_SERVICE,
  DESKTOP_REPORT_INGESTION_SERVICE,
  CollectorEvidenceAuthenticationGuard,
  CollectorAgentHttpController
} from "./http/collector-agent-http.controller.ts";
import { HealthHttpController } from "./http/health-http.controller.ts";
import { OperationsHttpController } from "./http/operations-http.controller.ts";
import {
  COLLECTION_EVIDENCE_STORE,
  COLLECTION_REPORT_QUERY_SERVICE,
  OperationsCollectionRunsHttpController
} from "./http/operations-collection-runs-http.controller.ts";
import { SettingsHttpController } from "./http/settings-http.controller.ts";
import {
  COLLECTION_RUN_QUEUE_SERVICE,
  CollectionRunsHttpController
} from "./http/collection-runs-http.controller.ts";
import {
  collectionRunQueueService,
  collectionEvidenceStore,
  collectionReportQuery,
  collectorAgentService,
  desktopReportIngestionService
} from "./runtime.ts";

@Module({
  controllers: [
    HealthHttpController,
    CatalogHttpController,
    AlertsHttpController,
    OperationsHttpController,
    OperationsCollectionRunsHttpController,
    SettingsHttpController,
    CollectionRunsHttpController,
    CollectorAgentHttpController
  ],
  providers: [
    { provide: COLLECTOR_AGENT_SERVICE, useValue: collectorAgentService },
    { provide: DESKTOP_REPORT_INGESTION_SERVICE, useValue: desktopReportIngestionService },
    { provide: COLLECTION_RUN_QUEUE_SERVICE, useValue: collectionRunQueueService },
    { provide: COLLECTION_REPORT_QUERY_SERVICE, useValue: collectionReportQuery },
    { provide: COLLECTION_EVIDENCE_STORE, useValue: collectionEvidenceStore },
    CollectorEvidenceAuthenticationGuard,
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector) => new RolesGuard(reflector)
    }
  ]
})
export class AppModule {}
