import { adminPrincipalConfigFromEnvironment, type AdminPrincipalConfig } from "../auth/verified-principal.ts";
import { parseCollectorReportJsonLimit } from "../http/api-body-parsing.ts";
import { normalizeNodeEnvironment } from "../runtime/node-environment.ts";
import { isIP } from "node:net";

export interface ApiStartupConfig {
  host: string;
  port: number;
  adminPrincipal: AdminPrincipalConfig;
  collectorReportJsonLimit: number;
  publicBaseUrl: string;
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  const port = normalized ? Number(normalized) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function settingsMasterKeyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = normalizeNodeEnvironment(environment.NODE_ENV)
): string {
  const configured = environment.SETTINGS_MASTER_KEY?.trim();
  if (configured) return configured;
  if (nodeEnvironment === "production") {
    throw new Error("SETTINGS_MASTER_KEY is required in production");
  }
  return "local-development-key-change-before-production";
}

export function databaseUrlFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  try {
    const parsedDatabaseUrl = new URL(databaseUrl);
    if (parsedDatabaseUrl.protocol !== "postgresql:" && parsedDatabaseUrl.protocol !== "postgres:") {
      throw new Error();
    }
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  return databaseUrl;
}

export function redisConnectionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const host = environment.REDIS_HOST === undefined ? "127.0.0.1" : environment.REDIS_HOST.trim();
  if (!host) throw new Error("REDIS_HOST must not be blank");
  return { host, port: parsePort("REDIS_PORT", environment.REDIS_PORT, 6380) };
}

export function publicBaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  apiPort = parsePort("API_PORT", environment.API_PORT, 4100)
): string {
  const configured = environment.PUBLIC_BASE_URL?.trim();
  let url: URL;
  try {
    url = new URL(configured || `http://127.0.0.1:${apiPort}`);
  } catch {
    throw new Error("PUBLIC_BASE_URL is invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || (!loopback && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("PUBLIC_BASE_URL is invalid");
  }
  return url.toString();
}

export function reportUrlForRun(publicBaseUrl: string, runId: string): string {
  return new URL(`/collection-runs/${encodeURIComponent(runId)}`, publicBaseUrl).toString();
}

function canonicalBindHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.split("%")[0] ?? host;
  if (isIP(host) === 6) {
    const normalized = new URL(`http://[${host}]`).hostname;
    return normalized.startsWith("[") ? normalized.slice(1, -1) : normalized;
  }
  return host;
}

function isLoopbackBindHost(value: string): boolean {
  const host = canonicalBindHost(value);
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

export function apiStartupConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): ApiStartupConfig {
  const nodeEnvironment = normalizeNodeEnvironment(environment.NODE_ENV);
  const host = environment.API_HOST?.trim() || "127.0.0.1";
  const port = parsePort("API_PORT", environment.API_PORT, 4100);
  if (
    nodeEnvironment === "production"
    && !isLoopbackBindHost(host)
    && environment.ALLOW_PRIVATE_NETWORK_API !== "true"
  ) {
    throw new Error("Non-loopback API_HOST requires ALLOW_PRIVATE_NETWORK_API=true in production");
  }

  databaseUrlFromEnvironment(environment);
  settingsMasterKeyFromEnvironment(environment, nodeEnvironment);
  redisConnectionFromEnvironment(environment);

  return {
    host,
    port,
    adminPrincipal: adminPrincipalConfigFromEnvironment(environment, nodeEnvironment),
    collectorReportJsonLimit: parseCollectorReportJsonLimit(environment.COLLECTOR_REPORT_JSON_LIMIT),
    publicBaseUrl: publicBaseUrlFromEnvironment(environment, port)
  };
}
