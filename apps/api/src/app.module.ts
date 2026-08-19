import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";

import { RolesGuard } from "./auth/roles.guard.ts";
import { AlertsHttpController } from "./http/alerts-http.controller.ts";
import { CatalogHttpController } from "./http/catalog-http.controller.ts";
import { HealthHttpController } from "./http/health-http.controller.ts";
import { OperationsHttpController } from "./http/operations-http.controller.ts";
import { SettingsHttpController } from "./http/settings-http.controller.ts";

@Module({
  controllers: [
    HealthHttpController,
    CatalogHttpController,
    AlertsHttpController,
    OperationsHttpController,
    SettingsHttpController
  ],
  providers: [{
    provide: APP_GUARD,
    inject: [Reflector],
    useFactory: (reflector: Reflector) => new RolesGuard(reflector)
  }]
})
export class AppModule {}
