import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DriverDiagnostic } from "./core/desktop-driver.ts";
import { AtomicCheckpointStore } from "./core/checkpoint-store.ts";
import { CollectionRunner } from "./core/collection-runner.ts";
import { AxHelperClient } from "./drivers/macos/ax-helper-client.ts";
import { TaobaoMacDriver } from "./drivers/macos/taobao-mac-driver.ts";
import { CollectorApiClient, type CollectorHealth } from "./agent/collector-api-client.ts";
import { loadCollectorConfig, type CollectorConfig } from "./agent/collector-config.ts";
import {
  CollectorWorker,
  type CollectorLogSummary,
  type OnceResult
} from "./agent/collector-worker.ts";
import { EvidenceUploader } from "./agent/evidence-uploader.ts";

export interface CollectorCliApi {
  checkReachability(): Promise<CollectorHealth>;
  checkPairing(): Promise<void>;
}

export interface CollectorCliWorker {
  once(): Promise<OnceResult>;
  run(): Promise<void>;
  stop(): void;
}

export interface CollectorDiagnosticDriver {
  diagnose(): Promise<DriverDiagnostic>;
  close(): void;
}

export interface CollectorCliDependencies {
  platform?: NodeJS.Platform;
  access?: (path: string, mode: number) => Promise<void>;
  createApi?: (config: CollectorConfig) => CollectorCliApi;
  createDiagnosticDriver?: (config: CollectorConfig) => CollectorDiagnosticDriver;
  createWorker?: (config: CollectorConfig, api: CollectorCliApi) => CollectorCliWorker;
  installSignalHandlers?: (worker: CollectorCliWorker) => () => void;
  log?: (summary: CollectorLogSummary) => void;
}

export type CollectorCliErrorCode =
  | "INVALID_COMMAND"
  | "PLATFORM_UNSUPPORTED"
  | "HELPER_UNAVAILABLE"
  | "TAOBAO_NOT_INSTALLED"
  | "ACCESSIBILITY_PERMISSION_REQUIRED"
  | "SCREEN_RECORDING_PERMISSION_REQUIRED"
  | "TAOBAO_NOT_RUNNING"
  | "TAOBAO_LOGIN_REQUIRED"
  | "TAOBAO_WINDOW_UNAVAILABLE"
  | "TAOBAO_VERSION_UNSUPPORTED"
  | "DIAGNOSTIC_FAILED";

export class CollectorCliError extends Error {
  readonly code: CollectorCliErrorCode;

  constructor(code: CollectorCliErrorCode) {
    super(`Collector CLI failed: ${code}`);
    this.name = "CollectorCliError";
    this.code = code;
  }
}

export type CollectorCliResult = "diagnosed" | OnceResult;

function fixedSummary(
  event: string,
  phase: string | null,
  errorCode: string | null = null
): CollectorLogSummary {
  return {
    event,
    runId: null,
    phase,
    discoveredCount: 0,
    skuCount: 0,
    errorCode
  };
}

function defaultCreateApi(config: CollectorConfig): CollectorApiClient {
  return new CollectorApiClient({
    apiUrl: config.apiUrl,
    pairingToken: config.pairingToken
  });
}

function defaultDiagnosticDriver(config: CollectorConfig): CollectorDiagnosticDriver {
  const client = new AxHelperClient({ helperPath: config.helperPath });
  const driver = new TaobaoMacDriver({ client, workDir: config.workDir });
  return {
    diagnose: () => driver.diagnose(),
    close: () => client.close()
  };
}

function defaultCreateWorker(
  config: CollectorConfig,
  diagnosticApi: CollectorCliApi,
  log: (summary: CollectorLogSummary) => void
): CollectorCliWorker {
  const api = diagnosticApi as CollectorApiClient;
  const checkpointStore = new AtomicCheckpointStore(config.workDir);
  const evidenceUploader = new EvidenceUploader(api, config.workDir);
  return new CollectorWorker({
    api,
    checkpointStore,
    evidenceUploader,
    appVersion: "2.4.5",
    capabilities: ["accessibility", "all-sku", "png-evidence"],
    log,
    runnerFactory(runId) {
      const client = new AxHelperClient({ helperPath: config.helperPath });
      const driver = new TaobaoMacDriver({
        client,
        workDir: join(config.workDir, runId)
      });
      const runner = new CollectionRunner(driver, checkpointStore);
      return {
        run: (job, collectorId, signal) => runner.run(job, collectorId, signal),
        close: () => client.close()
      };
    }
  });
}

function defaultSignalHandlers(worker: CollectorCliWorker): () => void {
  const stop = () => worker.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

function assertDiagnostic(diagnostic: DriverDiagnostic): void {
  if (!diagnostic.appInstalled) throw new CollectorCliError("TAOBAO_NOT_INSTALLED");
  if (!diagnostic.appRunning) throw new CollectorCliError("TAOBAO_NOT_RUNNING");
  if (!diagnostic.accessibilityTrusted) {
    throw new CollectorCliError("ACCESSIBILITY_PERMISSION_REQUIRED");
  }
  if (!diagnostic.screenRecordingTrusted) {
    throw new CollectorCliError("SCREEN_RECORDING_PERMISSION_REQUIRED");
  }
  if (diagnostic.appVersion !== "2.4.5" || diagnostic.appBuild !== "15") {
    throw new CollectorCliError("TAOBAO_VERSION_UNSUPPORTED");
  }
  if (!diagnostic.hasFrontWindow) throw new CollectorCliError("TAOBAO_WINDOW_UNAVAILABLE");
  if (diagnostic.loginState !== "LOGGED_IN") {
    throw new CollectorCliError("TAOBAO_LOGIN_REQUIRED");
  }
}

function commandFrom(argv: string[]): "diagnose" | "once" | "worker" {
  const commands = argv.filter((value) => value !== "--");
  if (commands.length !== 1
    || (commands[0] !== "diagnose" && commands[0] !== "once" && commands[0] !== "worker")) {
    throw new CollectorCliError("INVALID_COMMAND");
  }
  return commands[0];
}

export async function runCollectorCli(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
  dependencies: CollectorCliDependencies = {}
): Promise<CollectorCliResult> {
  const command = commandFrom(argv);
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new CollectorCliError("PLATFORM_UNSUPPORTED");
  }

  const collectorRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const config = loadCollectorConfig(environment, { collectorRoot });
  try {
    await (dependencies.access ?? access)(config.helperPath, constants.X_OK);
  } catch {
    throw new CollectorCliError("HELPER_UNAVAILABLE");
  }

  const log = dependencies.log ?? ((summary) => console.log(JSON.stringify(summary)));
  const api = (dependencies.createApi ?? defaultCreateApi)(config);

  if (command === "diagnose") {
    await api.checkReachability();
    await api.checkPairing();
    const driver = (dependencies.createDiagnosticDriver ?? defaultDiagnosticDriver)(config);
    let diagnostic: DriverDiagnostic;
    try {
      diagnostic = await driver.diagnose();
    } catch (error) {
      const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
      const mapped = code === "APP_VERSION_UNSUPPORTED"
        ? "TAOBAO_VERSION_UNSUPPORTED"
        : code;
      if (
        mapped === "TAOBAO_NOT_INSTALLED"
        || mapped === "TAOBAO_NOT_RUNNING"
        || mapped === "ACCESSIBILITY_PERMISSION_REQUIRED"
        || mapped === "SCREEN_RECORDING_PERMISSION_REQUIRED"
        || mapped === "TAOBAO_VERSION_UNSUPPORTED"
      ) throw new CollectorCliError(mapped);
      throw new CollectorCliError("DIAGNOSTIC_FAILED");
    } finally {
      driver.close();
    }
    assertDiagnostic(diagnostic);
    log(fixedSummary("diagnose_complete", "DIAGNOSE"));
    return "diagnosed";
  }

  const worker = dependencies.createWorker
    ? dependencies.createWorker(config, api)
    : defaultCreateWorker(config, api, log);
  const cleanupSignals = (dependencies.installSignalHandlers ?? defaultSignalHandlers)(worker);
  try {
    if (command === "once") return await worker.once();
    await worker.run();
    return "stopped";
  } finally {
    cleanupSignals();
  }
}

function safeTopLevelCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNEXPECTED_ERROR";
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "UNEXPECTED_ERROR";
}

async function main(): Promise<void> {
  try {
    await runCollectorCli(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify(fixedSummary("collector_failed", null, safeTopLevelCode(error))));
    process.exitCode = 1;
  }
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) await main();
