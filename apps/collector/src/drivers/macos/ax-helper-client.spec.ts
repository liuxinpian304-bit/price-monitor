import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DriverIssueError, UiContractChangedError } from "../../core/desktop-driver.ts";
import {
  AX_HELPER_TIMEOUT_MS,
  AxHelperResponseError,
  AxHelperClient,
  defaultAxHelperPath,
  type AxHelperProcess,
  type AxHelperSpawn
} from "./ax-helper-client.ts";
import { fingerprintFor, type AxNode } from "./ax-node.ts";

const localPathMarker = `/${"Users"}/`;
const privateLocalPath = `${localPathMarker}example/private`;

class FakeProcess implements AxHelperProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private readonly listeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  kill(): boolean {
    this.killed = true;
    return true;
  }

  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit" | "error", listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
    | ((error: Error) => void)): this {
    if (event === "exit") {
      this.listeners.add(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    } else {
      this.errorListeners.add(listener as (error: Error) => void);
    }
    return this;
  }

  emitExit(code = 1): void {
    for (const listener of this.listeners) listener(code, null);
    this.listeners.clear();
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener(new Error("private spawn failure"));
    this.errorListeners.clear();
  }
}

function response(process: FakeProcess, value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function skuOption(): AxNode {
  return {
    path: [4, 2],
    role: "AXGroup",
    subrole: null,
    identifier: null,
    title: null,
    description: null,
    value: null,
    url: null,
    enabled: true,
    selected: false,
    position: null,
    size: null,
    actions: ["AXShowMenu", "AXScrollToVisible"],
    children: [],
    domClassList: ["valueItem--fixture", "isSelected--fixture"]
  };
}

test("fingerprint copies a sorted DOM class list", () => {
  const option = skuOption();
  const originalClasses = option.domClassList;

  const fingerprint = fingerprintFor(option);

  assert.deepEqual(fingerprint.domClassList, ["isSelected--fixture", "valueItem--fixture"]);
  assert.notEqual(fingerprint.domClassList, originalClasses);
  assert.deepEqual(option.domClassList, ["valueItem--fixture", "isSelected--fixture"]);
});

test("uses the exact required command timeout", () => {
  assert.equal(AX_HELPER_TIMEOUT_MS, 15_000);
  assert.equal(defaultAxHelperPath().endsWith(
    join("apps", "collector-macos", ".build", "debug", "taobao-ax-helper")
  ), true);
});

test("passes the configured absolute evidence root to the helper process", async () => {
  const process = new FakeProcess();
  let spawnArguments: unknown[] = [];
  const spawn = ((...arguments_: unknown[]) => {
    spawnArguments = arguments_;
    return process;
  }) as AxHelperSpawn;
  const client = new AxHelperClient({
    spawn,
    evidenceRoot: "/private/tmp/stau-collector-evidence"
  });
  process.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string };
    response(process, { id: command.id, ok: true, payload: { appInstalled: true } });
  });

  await client.command("diagnose");

  assert.equal(
    (spawnArguments[1] as NodeJS.ProcessEnv | undefined)?.COLLECTOR_WORK_DIR,
    "/private/tmp/stau-collector-evidence"
  );
  client.close();
});

test("normalizes omitted nullable fields in recursive helper snapshots", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  process.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string };
    response(process, {
      id: command.id,
      ok: true,
      payload: {
        path: [],
        actions: [],
        children: [{ path: [0], actions: [], children: [{ path: [0, 0], actions: [], children: [] }] }]
      }
    });
  });

  const snapshot = await client.snapshot();

  assert.equal(snapshot.title, null);
  assert.equal(snapshot.value, null);
  assert.equal(snapshot.children[0]?.description, null);
  assert.equal(snapshot.children[0]?.children[0]?.url, null);
  client.close();
});

test("rejects non-object snapshot children with the snapshot contract error", async () => {
  for (const invalidChild of [0, false, "invalid", null]) {
    const process = new FakeProcess();
    const client = new AxHelperClient({ spawn: () => process });
    process.stdin.once("data", (chunk) => {
      const command = JSON.parse(String(chunk)) as { id: string };
      response(process, {
        id: command.id,
        ok: true,
        payload: { path: [], actions: [], children: [invalidChild] }
      });
    });

    await assert.rejects(client.snapshot(), (error: unknown) => {
      assert.equal(error instanceof UiContractChangedError, true);
      assert.equal((error as Error).message, "Taobao Accessibility helper emitted an invalid snapshot.");
      return true;
    });
    client.close();
  }
});

test("sends activation and Unicode replacement commands through the helper protocol", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  const commands: Array<Record<string, unknown>> = [];
  process.stdin.on("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string; command: string } & Record<string, unknown>;
    commands.push(command);
    response(process, {
      id: command.id,
      ok: true,
      payload: command.command === "activate" ? { activated: true } : { typed: true }
    });
  });

  const activation = client.command("activate");
  const replacement = client.command("replaceText", {
    nodePath: [0, 1],
    value: "声卡 直播",
    fingerprint: { role: "AXTextField" }
  });

  assert.deepEqual(await activation, { activated: true });
  assert.deepEqual(await replacement, { typed: true });
  assert.deepEqual(commands.map(({ id, ...command }) => command), [
    { command: "activate", bundleId: "com.taobao.pcdesktop" },
    {
      command: "replaceText",
      bundleId: "com.taobao.pcdesktop",
      nodePath: [0, 1],
      value: "声卡 直播",
      fingerprint: { role: "AXTextField" }
    }
  ]);
  client.close();
});

test("pressSkuOption sends only the guarded SKU target fields", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  let sent: Record<string, unknown> | undefined;
  process.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string } & Record<string, unknown>;
    sent = command;
    response(process, { id: command.id, ok: true, payload: { performed: true } });
  });

  await client.pressSkuOption(skuOption(), "Fixture Blue");

  const { id, bundleId, ...request } = sent!;
  assert.match(String(id), /^[0-9a-f-]{36}$/i);
  assert.equal(bundleId, "com.taobao.pcdesktop");
  assert.deepEqual(request, {
    command: "pressSkuOption",
    nodePath: [4, 2],
    value: "Fixture Blue",
    fingerprint: {
      role: "AXGroup",
      domClassList: ["isSelected--fixture", "valueItem--fixture"]
    }
  });
  client.close();
});

test("pressSkuOption fails closed before starting the helper for weak SKU fingerprints", async () => {
  const missingRole = skuOption();
  missingRole.role = null;
  const missingClassList = skuOption();
  delete missingClassList.domClassList;
  const weakOptions = [
    missingRole,
    missingClassList,
    { ...skuOption(), domClassList: [] },
    { ...skuOption(), domClassList: ["valueItem--fixture", "valueItem--fixture"] },
    { ...skuOption(), domClassList: ["valueItem--fixture", "valueItem--alternate"] },
    { ...skuOption(), domClassList: ["valueItem--fixture", "isSelected--fixture", "isSelected--fixture"] }
  ];

  for (const option of weakOptions) {
    let spawns = 0;
    const client = new AxHelperClient({
      timeoutMs: 1,
      spawn: () => {
        spawns += 1;
        return new FakeProcess();
      }
    });

    await assert.rejects(client.pressSkuOption(option, "Fixture Blue"), UiContractChangedError);
    assert.equal(spawns, 0);
    client.close();
  }
});

test("pressSkuOption fails closed on malformed success acknowledgements", async () => {
  for (const payload of [undefined, null, {}, { performed: false }, { performed: "true" }]) {
    const process = new FakeProcess();
    const client = new AxHelperClient({ spawn: () => process });
    process.stdin.once("data", (chunk) => {
      const command = JSON.parse(String(chunk)) as { id: string };
      response(process, { id: command.id, ok: true, payload });
    });

    await assert.rejects(client.pressSkuOption(skuOption(), "Fixture Blue"), UiContractChangedError);
    client.close();
  }
});

test("correlates concurrent one-line responses by UUID", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  const commands: Array<Record<string, unknown>> = [];
  process.stdin.on("data", (chunk) => {
    commands.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    if (commands.length === 2) {
      response(process, { id: commands[1]?.id, ok: true, payload: { order: 2 } });
      response(process, { id: commands[0]?.id, ok: true, payload: { order: 1 } });
    }
  });

  const first = client.command("snapshot");
  const second = client.command("diagnose");
  assert.deepEqual(await first, { order: 1 });
  assert.deepEqual(await second, { order: 2 });
  assert.notEqual(commands[0]?.id, commands[1]?.id);
  assert.equal(commands.every((command) => command.bundleId === "com.taobao.pcdesktop"), true);
  client.close();
});

test("preserves a Chinese JSON payload when stdout splits one UTF-8 code point", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  let commandId = "";
  process.stdin.once("data", (chunk) => {
    commandId = (JSON.parse(String(chunk)) as { id: string }).id;
    const encoded = Buffer.from(JSON.stringify({
      id: commandId,
      ok: true,
      payload: { text: "淘宝" }
    }) + "\n", "utf8");
    const characterStart = encoded.indexOf(Buffer.from("淘", "utf8"));
    assert.notEqual(characterStart, -1);
    process.stdout.write(encoded.subarray(0, characterStart + 1));
    process.stdout.write(encoded.subarray(characterStart + 1));
  });

  assert.deepEqual(await client.command("captureCopiedText"), { text: "淘宝" });
  assert.match(commandId, /^[0-9a-f-]{36}$/);
  client.close();
});

test("restarts a failed helper exactly once and then surfaces a sanitized contract error", async () => {
  const processes = [new FakeProcess(), new FakeProcess(), new FakeProcess()];
  let spawns = 0;
  const spawn: AxHelperSpawn = () => processes[spawns++]!;
  const client = new AxHelperClient({ spawn, timeoutMs: 50 });

  for (const process of processes.slice(0, 2)) {
    process.stdin.once("data", () => process.emitExit());
  }

  await assert.rejects(client.command("snapshot"), (error: unknown) => {
    assert.equal(error instanceof UiContractChangedError, true);
    assert.equal((error as Error).message.includes(localPathMarker), false);
    return true;
  });
  assert.equal(spawns, 2);
  client.close();
});

test("times out, performs one clean restart, and never leaks raw stderr", async () => {
  const processes = [new FakeProcess(), new FakeProcess()];
  const diagnostics: string[] = [];
  let spawns = 0;
  const client = new AxHelperClient({
    spawn: () => processes[spawns++]!,
    timeoutMs: 10,
    onDiagnostic: (message) => diagnostics.push(message)
  });
  processes[0]?.stderr.write(`token=super-secret ${privateLocalPath}\n`);

  await assert.rejects(client.command("diagnose"), UiContractChangedError);
  assert.equal(spawns, 2);
  assert.equal(diagnostics.join(" ").includes("super-secret"), false);
  assert.equal(diagnostics.join(" ").includes(localPathMarker), false);
  client.close();
});

test("restarts once after malformed protocol stdout", async () => {
  const processes = [new FakeProcess(), new FakeProcess()];
  let spawns = 0;
  const client = new AxHelperClient({ spawn: () => processes[spawns++]! });
  processes[0]?.stdin.once("data", () => processes[0]?.stdout.write("not-json\n"));
  processes[1]?.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string };
    response(processes[1]!, { id: command.id, ok: true, payload: { recovered: true } });
  });

  assert.deepEqual(await client.command("snapshot"), { recovered: true });
  assert.equal(spawns, 2);
  client.close();
});

test("surfaces typed helper errors without restarting or leaking unsafe messages", async () => {
  const process = new FakeProcess();
  let spawns = 0;
  const client = new AxHelperClient({ spawn: () => { spawns += 1; return process; } });
  process.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string };
    response(process, {
      id: command.id,
      ok: false,
      error: { code: "APP_NOT_RUNNING", message: `token=private ${privateLocalPath}` }
    });
  });

  await assert.rejects(client.command("diagnose"), (error: unknown) => {
    assert.equal(error instanceof AxHelperResponseError, true);
    assert.equal((error as AxHelperResponseError).code, "APP_NOT_RUNNING");
    assert.equal((error as Error).message.includes("private"), false);
    assert.equal((error as Error).message.includes(localPathMarker), false);
    return true;
  });
  assert.equal(spawns, 1);
  client.close();
});

test("translates a non-frontmost keypress response into a terminal driver issue", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  process.stdin.once("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string };
    response(process, {
      id: command.id,
      ok: false,
      error: { code: "APP_NOT_FRONTMOST", message: `token=private ${privateLocalPath}` }
    });
  });

  await assert.rejects(client.command("keyPress", { keyCode: 36 }), (error: unknown) => {
    assert.equal(error instanceof DriverIssueError, true);
    assert.equal((error as DriverIssueError).code, "TAOBAO_NOT_FRONTMOST");
    assert.equal((error as Error).message, "Taobao Desktop is not frontmost.");
    return true;
  });
  client.close();
});

test("translates activation and replacement frontmost failures into terminal driver issues", async () => {
  const process = new FakeProcess();
  const client = new AxHelperClient({ spawn: () => process });
  process.stdin.on("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string; command: string };
    response(process, {
      id: command.id,
      ok: false,
      error: {
        code: command.command === "activate" ? "APP_ACTIVATION_FAILED" : "APP_NOT_FRONTMOST",
        message: `token=private ${privateLocalPath}`
      }
    });
  });

  const requests = [
    () => client.command("activate"),
    () => client.command("replaceText", {
      nodePath: [0, 1],
      value: "声卡 直播",
      fingerprint: { role: "AXTextField" }
    })
  ];
  for (const request of requests) {
    await assert.rejects(request(), (error: unknown) => {
      assert.equal(error instanceof DriverIssueError, true);
      assert.equal((error as DriverIssueError).code, "TAOBAO_NOT_FRONTMOST");
      assert.equal((error as Error).message, "Taobao Desktop is not frontmost.");
      assert.equal((error as Error).message.includes("private"), false);
      return true;
    });
  }
  client.close();
});

test("preserves allowlisted tree-limit diagnostics without restarting the helper", async () => {
  const process = new FakeProcess();
  let spawns = 0;
  const client = new AxHelperClient({ spawn: () => { spawns += 1; return process; } });
  process.stdin.once("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as { id: string };
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: {
        code: "TREE_LIMIT_REACHED",
        message: "Accessibility tree limit reached.",
        details: {
          reason: "nodeCount",
          scope: "focusedWindow",
          visitedNodeCount: 4001,
          maximumDepth: 18,
          elapsedMilliseconds: 420,
          encodedBytes: 0,
          unexpected: "must-not-propagate"
        }
      }
    })}\n`);
  });

  await assert.rejects(client.snapshot(), (error: unknown) => {
    assert.equal(error instanceof AxHelperResponseError, true);
    const response = error as AxHelperResponseError;
    assert.equal(response.code, "TREE_LIMIT_REACHED");
    assert.deepEqual(response.details, {
      reason: "nodeCount",
      scope: "focusedWindow",
      visitedNodeCount: 4001,
      maximumDepth: 18,
      elapsedMilliseconds: 420,
      encodedBytes: 0
    });
    return true;
  });
  assert.equal(spawns, 1);
  client.close();
});

test("shares one clean restart across concurrent commands after process failure", async () => {
  const processes = [new FakeProcess(), new FakeProcess()];
  let spawns = 0;
  const client = new AxHelperClient({ spawn: () => processes[spawns++]! });
  let firstGenerationWrites = 0;
  processes[0]?.stdin.on("data", () => {
    firstGenerationWrites += 1;
    if (firstGenerationWrites === 2) processes[0]?.emitError();
  });
  processes[1]?.stdin.on("data", (chunk) => {
    const command = JSON.parse(String(chunk)) as { id: string; command: string };
    response(processes[1]!, { id: command.id, ok: true, payload: { command: command.command } });
  });

  const results = await Promise.all([client.command("snapshot"), client.command("diagnose")]);
  assert.deepEqual(results, [{ command: "snapshot" }, { command: "diagnose" }]);
  assert.equal(spawns, 2);
  client.close();
});
