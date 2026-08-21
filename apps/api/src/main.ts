import "reflect-metadata";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.ts";
import { closeRuntime } from "./runtime.ts";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix("api");
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
