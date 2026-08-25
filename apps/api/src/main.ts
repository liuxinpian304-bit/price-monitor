import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";

import { AppModule } from "./app.module.ts";
import { configureApiBodyParsing } from "./http/api-body-parsing.ts";
import { closeRuntime, collectionEvidenceStore, collectorAgentService, startRuntime } from "./runtime.ts";

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

  await startRuntime();
  const port = Number(process.env.API_PORT ?? 4100);
  const host = process.env.API_HOST?.trim() || "127.0.0.1";
  if (process.env.NODE_ENV === "production" && host === "0.0.0.0" && process.env.ALLOW_PRIVATE_NETWORK_API !== "true") {
    throw new Error("API_HOST=0.0.0.0 requires ALLOW_PRIVATE_NETWORK_API=true in production");
  }
  await app.listen(port, host);

  const shutdown = async () => {
    await app.close();
    await closeRuntime();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await bootstrap();
