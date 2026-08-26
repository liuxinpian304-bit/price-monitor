import {
  apiStartupConfigFromEnvironment,
  type ApiStartupConfig
} from "./api-startup-config.ts";

export interface ApiBootstrapApplication {
  listen(port: number, host: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface ApiBootstrapDependencies<Application extends ApiBootstrapApplication> {
  initializeRuntimeResources(): Promise<void>;
  createApplication(): Promise<Application>;
  configureApplication(app: Application, config: ApiStartupConfig): Promise<void> | void;
  startRuntime(): Promise<void>;
  closeRuntime(): Promise<void>;
}

export interface StartedApi<Application extends ApiBootstrapApplication> {
  app: Application;
  close(): Promise<void>;
}

async function closeResources<Application extends ApiBootstrapApplication>(
  app: Application | null,
  dependencies: ApiBootstrapDependencies<Application>
): Promise<void> {
  const errors: unknown[] = [];
  if (app) {
    try {
      await app.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await dependencies.closeRuntime();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "API resource cleanup failed");
}

export async function bootstrapApi<Application extends ApiBootstrapApplication>(
  environment: NodeJS.ProcessEnv,
  loadDependencies: (
    config: ApiStartupConfig
  ) => Promise<ApiBootstrapDependencies<Application>>
): Promise<StartedApi<Application>> {
  const config = apiStartupConfigFromEnvironment(environment);
  const dependencies = await loadDependencies(config);
  let app: Application | null = null;

  try {
    await dependencies.initializeRuntimeResources();
    app = await dependencies.createApplication();
    await dependencies.configureApplication(app, config);
    await dependencies.startRuntime();
    await app.listen(config.port, config.host);
  } catch (startupError) {
    try {
      await closeResources(app, dependencies);
    } catch (cleanupError) {
      if (startupError instanceof Error) {
        Object.defineProperty(startupError, "cleanupError", { value: cleanupError });
      }
    }
    throw startupError;
  }

  let closed = false;
  return {
    app,
    async close() {
      if (closed) return;
      closed = true;
      await closeResources(app, dependencies);
    }
  };
}
