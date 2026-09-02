import { isProductionEnvironment } from "../runtime/node-environment.ts";

export function assertDemoSeedAllowed(environment: NodeJS.ProcessEnv = process.env): void {
  if (isProductionEnvironment(environment.NODE_ENV) && environment.ALLOW_DEMO_SEED !== "true") {
    throw new Error("生产环境禁止写入演示数据");
  }
}
