import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { UiContractChangedError } from "../../core/desktop-driver.ts";
import type { AxJsonValue, AxNode, AxNodeFingerprint } from "./ax-node.ts";

export const AX_HELPER_TIMEOUT_MS = 15_000;
export const TAOBAO_BUNDLE_ID = "com.taobao.pcdesktop";

export type AxHelperCommandName =
  | "diagnose"
  | "snapshot"
  | "perform"
  | "setValue"
  | "keyPress"
  | "captureCopiedText"
  | "screenshot";

export interface AxHelperCommandFields {
  nodePath?: number[];
  action?: string;
  value?: string;
  keyCode?: number;
  destination?: string;
  fingerprint?: AxNodeFingerprint;
}

export interface AxHelperDiagnosticPayload {
  trusted: boolean;
  appRunning: boolean;
  pid: number | null;
  bundleId: string | null;
  shortVersion: string | null;
  build: string | null;
  frontWindowAvailable: boolean;
}

export interface AxHelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type AxHelperSpawn = (path: string) => AxHelperProcess;

interface AxHelperResponse {
  id: string;
  ok: boolean;
  payload?: AxJsonValue;
  error?: { code: string; message: string };
}

interface Pending {
  resolve: (payload: AxJsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class HelperTransportError extends Error {}

export class AxHelperResponseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(sanitizeDiagnostic(message) || "Taobao Accessibility helper command failed.");
    this.name = "AxHelperResponseError";
    this.code = sanitizeCode(code);
  }
}

export interface AxHelperClientOptions {
  helperPath?: string;
  timeoutMs?: number;
  spawn?: AxHelperSpawn;
  onDiagnostic?: (message: string) => void;
}

export function defaultAxHelperPath(): string {
  const configured = process.env.TAOBAO_AX_HELPER_PATH;
  if (configured) return configured;
  return fileURLToPath(new URL("../../../../collector-macos/.build/debug/taobao-ax-helper", import.meta.url));
}

function defaultSpawn(path: string): AxHelperProcess {
  return nodeSpawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
}

function sanitizeCode(code: string): string {
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "HELPER_ERROR";
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\/Users\/[^\s]+/g, "[local-path]")
    .replace(/(?:token|cookie|authorization|webhook)\s*[=:]\s*[^\s]+/gi, "[sensitive]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}

function isResponse(value: unknown): value is AxHelperResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<AxHelperResponse>;
  return typeof response.id === "string" && typeof response.ok === "boolean";
}

export class AxHelperClient {
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly spawnHelper: AxHelperSpawn;
  private readonly onDiagnostic: (message: string) => void;
  private readonly pending = new Map<string, Pending>();
  private process: AxHelperProcess | null = null;
  private stdoutBuffer = "";
  private closed = false;

  constructor(options: AxHelperClientOptions = {}) {
    this.helperPath = options.helperPath ?? defaultAxHelperPath();
    this.timeoutMs = options.timeoutMs ?? AX_HELPER_TIMEOUT_MS;
    this.spawnHelper = options.spawn ?? defaultSpawn;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  async command<T = AxJsonValue | undefined>(
    command: AxHelperCommandName,
    fields: AxHelperCommandFields = {}
  ): Promise<T> {
    let lastFailure: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.sendOnce(command, fields) as T;
      } catch (error) {
        if (!(error instanceof HelperTransportError)) throw error;
        lastFailure = error;
      }
    }
    throw new UiContractChangedError(
      lastFailure?.message === "Taobao Accessibility helper command timed out."
        ? "Taobao Accessibility helper timed out after one clean restart."
        : "Taobao Accessibility helper failed after one clean restart."
    );
  }

  async diagnose(): Promise<AxHelperDiagnosticPayload> {
    return await this.command<AxHelperDiagnosticPayload>("diagnose");
  }

  async snapshot(): Promise<AxNode> {
    return await this.command<AxNode>("snapshot");
  }

  close(): void {
    this.closed = true;
    this.rejectPending(new HelperTransportError("Taobao Accessibility helper client closed."));
    this.cleanProcess();
  }

  private sendOnce(command: AxHelperCommandName, fields: AxHelperCommandFields): Promise<AxJsonValue | undefined> {
    if (this.closed) throw new UiContractChangedError("Taobao Accessibility helper client is closed.");
    const process = this.ensureProcess();
    const id = randomUUID();
    const line = `${JSON.stringify({ id, command, bundleId: TAOBAO_BUNDLE_ID, ...fields })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new HelperTransportError("Taobao Accessibility helper command timed out."));
        this.failTransport(process, "Taobao Accessibility helper command timed out.");
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        process.stdin.write(line, (error) => {
          if (error) this.failTransport(process, "Taobao Accessibility helper input failed.");
        });
      } catch {
        this.failTransport(process, "Taobao Accessibility helper input failed.");
      }
    });
  }

  private ensureProcess(): AxHelperProcess {
    if (this.process) return this.process;
    const process = this.spawnHelper(this.helperPath);
    this.process = process;
    this.stdoutBuffer = "";
    process.stdout.on("data", (chunk: Buffer | string) => this.consumeStdout(process, String(chunk)));
    process.stderr.on("data", () => this.onDiagnostic("Taobao Accessibility helper stderr was redacted."));
    process.once("exit", () => this.failTransport(process, "Taobao Accessibility helper exited."));
    process.once("error", () => this.failTransport(process, "Taobao Accessibility helper could not start."));
    return process;
  }

  private consumeStdout(process: AxHelperProcess, chunk: string): void {
    if (process !== this.process) return;
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        this.failTransport(process, "Taobao Accessibility helper emitted invalid protocol output.");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        this.failTransport(process, "Taobao Accessibility helper emitted invalid protocol output.");
        return;
      }
      if (!isResponse(decoded)) {
        this.failTransport(process, "Taobao Accessibility helper emitted invalid protocol output.");
        return;
      }
      const pending = this.pending.get(decoded.id);
      if (!pending) {
        this.failTransport(process, "Taobao Accessibility helper emitted an unexpected response.");
        return;
      }
      this.pending.delete(decoded.id);
      clearTimeout(pending.timer);
      if (decoded.ok) {
        pending.resolve(decoded.payload);
      } else {
        pending.reject(new AxHelperResponseError(
          decoded.error?.code ?? "HELPER_ERROR",
          decoded.error?.message ?? "Taobao Accessibility helper command failed."
        ));
      }
    }
  }

  private failTransport(process: AxHelperProcess, message: string): void {
    if (process !== this.process) return;
    this.rejectPending(new HelperTransportError(message));
    this.cleanProcess();
  }

  private rejectPending(error: HelperTransportError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private cleanProcess(): void {
    const process = this.process;
    this.process = null;
    this.stdoutBuffer = "";
    if (process) process.kill("SIGTERM");
  }
}
