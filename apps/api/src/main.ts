import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module.ts";
import { configureApiBodyParsing } from "./http/api-body-parsing.ts";
import { closeRuntime, collectionEvidenceStore, collectorAgentService } from "./runtime.ts";

async function bootstrap() {
  await collectionEvidenceStore.initialize();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    { cors: false, bodyParser: false }
  );
  app.setGlobalPrefix("api");
  configureApiBodyParsing(app, collectorAgentService);
  app.enableCors({ origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/] });
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4100);
  await app.listen(port, "127.0.0.1");

  const shutdown = async () => {
    await app.close();
    await closeRuntime();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await bootstrap();
