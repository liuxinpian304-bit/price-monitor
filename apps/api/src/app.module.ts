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
import { SettingsHttpController } from "./http/settings-http.controller.ts";
import { collectorAgentService, desktopReportIngestionService } from "./runtime.ts";

@Module({
  controllers: [
    HealthHttpController,
    CatalogHttpController,
    AlertsHttpController,
    OperationsHttpController,
    SettingsHttpController,
    CollectorAgentHttpController
  ],
  providers: [
    { provide: COLLECTOR_AGENT_SERVICE, useValue: collectorAgentService },
    { provide: DESKTOP_REPORT_INGESTION_SERVICE, useValue: desktopReportIngestionService },
    CollectorEvidenceAuthenticationGuard,
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector) => new RolesGuard(reflector)
    }
  ]
})
export class AppModule {}
