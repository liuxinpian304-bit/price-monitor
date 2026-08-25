import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapApi,
  type ApiBootstrapApplication,
  type ApiBootstrapDependencies
} from "./api-bootstrap.ts";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app"
};

function dependencies(events: string[], failAt?: string): ApiBootstrapDependencies<ApiBootstrapApplication> {
  const step = async (name: string) => {
    events.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
  };
  const app: ApiBootstrapApplication = {
    listen: async () => step("listen"),
    close: async () => step("app.close")
  };
  return {
    initializeRuntimeResources: async () => step("initialize"),
    createApplication: async () => {
      await step("create");
      return app;
    },
    configureApplication: async () => step("configure"),
    startRuntime: async () => step("runtime.start"),
    closeRuntime: async () => step("runtime.close")
  };
}

test("invalid startup configuration is rejected before dependencies can create resources", async () => {
  let loaded = false;

  await assert.rejects(
    bootstrapApi({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://service:secret@127.0.0.1:5432/app",
      SETTINGS_MASTER_KEY: "test-production-settings-key",
      API_HOST: "0.0.0.0"
    }, async () => {
      loaded = true;
      return dependencies([]);
    }),
    /API_HOST/
  );

  assert.equal(loaded, false);
});

test("bootstrap validates, initializes and listens in a deterministic order", async () => {
  const events: string[] = [];
  const started = await bootstrapApi(validEnvironment, async (config) => {
    events.push(`load:${config.host}:${config.port}`);
    return dependencies(events);
  });

  assert.deepEqual(events, ["load:127.0.0.1:4100", "initialize", "create", "configure", "runtime.start", "listen"]);
  await started.close();
  assert.deepEqual(events.slice(-2), ["app.close", "runtime.close"]);
});

for (const failAt of ["initialize", "create", "configure", "runtime.start", "listen"]) {
  test(`bootstrap cleans up resources when ${failAt} fails`, async () => {
    const events: string[] = [];

    await assert.rejects(
      bootstrapApi(validEnvironment, async () => dependencies(events, failAt)),
      new RegExp(`${failAt.replace(".", "\\.")} failed`)
    );

    const appWasCreated = !["initialize", "create"].includes(failAt);
    assert.deepEqual(
      events.slice(appWasCreated ? -2 : -1),
      appWasCreated ? ["app.close", "runtime.close"] : ["runtime.close"]
    );
  });
}

test("runtime cleanup still runs when application cleanup also fails", async () => {
  const events: string[] = [];
  const deps = dependencies(events, "listen");
  deps.createApplication = async () => ({
    listen: async () => {
      events.push("listen");
      throw new Error("listen failed");
    },
    close: async () => {
      events.push("app.close");
      throw new Error("app close failed");
    }
  });

  await assert.rejects(bootstrapApi(validEnvironment, async () => deps), /listen failed/);
  assert.deepEqual(events.slice(-2), ["app.close", "runtime.close"]);
});
