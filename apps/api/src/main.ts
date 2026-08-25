import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { createVerifiedPrincipalMiddleware } from "./auth/verified-principal.ts";
import { configureApiBodyParsing } from "./http/api-body-parsing.ts";
import { bootstrapApi } from "./startup/api-bootstrap.ts";

async function bootstrap() {
  const started = await bootstrapApi<NestExpressApplication>(process.env, async () => {
    let runtime: typeof import("./runtime.ts") | null = null;
    try {
      runtime = await import("./runtime.ts");
      const { AppModule } = await import("./app.module.ts");
      return {
        initializeRuntimeResources: () => runtime!.collectionEvidenceStore.initialize(),
        createApplication: () => NestFactory.create<NestExpressApplication>(
          AppModule,
          { cors: false, bodyParser: false }
        ),
        configureApplication(app, config) {
          app.setGlobalPrefix("api");
          app.use(createVerifiedPrincipalMiddleware(config.adminPrincipal));
          configureApiBodyParsing(app, runtime!.collectorAgentService, config.collectorReportJsonLimit);
          app.enableCors({ origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/] });
        },
        startRuntime: () => runtime!.startRuntime(),
        closeRuntime: () => runtime!.closeRuntime()
      };
    } catch (error) {
      if (runtime) await runtime.closeRuntime();
      throw error;
    }
  });

  const shutdown = () => {
    void started.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await bootstrap();
