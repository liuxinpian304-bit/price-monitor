import { isAbsolute, relative, resolve } from "node:path";

export interface CollectorConfig {
  apiUrl: string;
  pairingToken: string;
  collectorName: string;
  helperPath: string;
  collectorRoot: string;
  workDir: string;
}

export interface CollectorConfigOptions {
  collectorRoot?: string;
}

const PAIRING_TOKEN_PATTERN = /^pmc_[A-Za-z0-9_-]{43}$/;
const CANONICAL_IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/;

function configurationError(name: string): TypeError {
  return new TypeError(`Invalid ${name}`);
}

function requiredValue(
  environment: Record<string, string | undefined>,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) throw configurationError(name);
  return value;
}

function isCanonicalLoopbackAuthority(authority: string): boolean {
  if (/^localhost(?::\d+)?$/i.test(authority)) return true;
  if (/^\[::1\](?::\d+)?$/i.test(authority)) return true;

  const match = CANONICAL_IPV4_PATTERN.exec(authority);
  if (!match) return false;
  const octets = match.slice(1, 5);
  if (octets.some((octet) => octet!.length > 1 && octet!.startsWith("0"))) return false;
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255);
}

function parseApiUrl(rawValue: string): string {
  const authorityMatch = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(rawValue);
  if (!authorityMatch?.[1] || !authorityMatch[2] || authorityMatch[2].includes("@")) {
    throw configurationError("COLLECTOR_API_URL");
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw configurationError("COLLECTOR_API_URL");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw configurationError("COLLECTOR_API_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError("COLLECTOR_API_URL");
  }
  if (url.protocol === "http:" && !isCanonicalLoopbackAuthority(authorityMatch[2])) {
    throw configurationError("COLLECTOR_API_URL");
  }
  if (url.protocol === "http:" && url.hostname.toLowerCase() === "localhost") {
    return `http://127.0.0.1${url.port ? `:${url.port}` : ""}`;
  }
  return url.origin;
}

function resolveWorkDirectory(collectorRoot: string, configured: string | undefined): string {
  const workDir = resolve(collectorRoot, configured?.trim() || "work/collector-runs");
  const relativePath = relative(collectorRoot, workDir);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(relativePath)) {
    throw configurationError("COLLECTOR_WORK_DIR");
  }
  return workDir;
}

export function loadCollectorConfig(
  environment: Record<string, string | undefined> = process.env,
  options: CollectorConfigOptions = {}
): CollectorConfig {
  const collectorRoot = resolve(options.collectorRoot ?? process.cwd());
  const pairingToken = requiredValue(environment, "COLLECTOR_PAIRING_TOKEN");
  if (!PAIRING_TOKEN_PATTERN.test(pairingToken)) {
    throw configurationError("COLLECTOR_PAIRING_TOKEN");
  }

  const helperPath = requiredValue(environment, "TAOBAO_AX_HELPER_PATH");
  return {
    apiUrl: parseApiUrl(requiredValue(environment, "COLLECTOR_API_URL")),
    pairingToken,
    collectorName: requiredValue(environment, "COLLECTOR_NAME"),
    helperPath: isAbsolute(helperPath) ? resolve(helperPath) : resolve(collectorRoot, helperPath),
    collectorRoot,
    workDir: resolveWorkDirectory(collectorRoot, environment.COLLECTOR_WORK_DIR)
  };
}

export function summarizeCollectorConfig(config: CollectorConfig): {
  event: "collector_config";
  apiProtocol: "http:" | "https:";
  workDirectoryConfigured: true;
  helperConfigured: true;
} {
  return {
    event: "collector_config",
    apiProtocol: new URL(config.apiUrl).protocol as "http:" | "https:",
    workDirectoryConfigured: true,
    helperConfigured: true
  };
}
