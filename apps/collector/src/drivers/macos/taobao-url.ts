import { UiContractChangedError } from "../../core/desktop-driver.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ParsedLiveItemUrl {
  platformItemId: string | null;
  url: string;
  sponsored: boolean;
}

function profileError(): never {
  throw new UiContractChangedError(PROFILE_ERROR);
}

function parseUrl(rawUrl: string | null): URL {
  if (!rawUrl) return profileError();
  try {
    return new URL(rawUrl);
  } catch {
    return profileError();
  }
}

function canonicalUrl(parsed: URL): string {
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

function stableItemId(parsed: URL, required: boolean): string | null {
  const values = ["id", "item_id", "itemId"].flatMap((name) => parsed.searchParams.getAll(name));
  if (values.some((value) => !ITEM_ID_PATTERN.test(value))) return profileError();
  const distinct = [...new Set(values)];
  if (distinct.length > 1 || (required && distinct.length !== 1)) return profileError();
  return distinct[0] ?? null;
}

function liveItemUrlKind(parsed: URL): "DIRECT" | "SPONSORED" | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if ((host === "detail.tmall.com" || host === "item.taobao.com") && parsed.pathname === "/item.htm") {
    return "DIRECT";
  }
  return host.endsWith(".simba.taobao.com") && parsed.pathname === "/auction" ? "SPONSORED" : null;
}

export function isSupportedLiveItemUrl(rawUrl: string | null): boolean {
  if (!rawUrl) return false;
  try {
    return liveItemUrlKind(new URL(rawUrl)) !== null;
  } catch {
    return false;
  }
}

export function canonicalItemIdentity(rawUrl: string | null): { platformItemId: string | null; url: string } {
  const parsed = parseUrl(rawUrl);
  parsed.hash = "";
  const candidate = parsed.searchParams.get("id")?.trim() ?? "";
  const platformItemId = ITEM_ID_PATTERN.test(candidate) ? candidate : null;
  parsed.searchParams.sort();
  return { platformItemId, url: parsed.toString() };
}

export function parseLiveItemUrl(rawUrl: string | null): ParsedLiveItemUrl {
  const parsed = parseUrl(rawUrl);
  const kind = liveItemUrlKind(parsed);
  if (kind === null) return profileError();
  const sponsored = kind === "SPONSORED";
  return {
    platformItemId: stableItemId(parsed, sponsored),
    url: canonicalUrl(parsed),
    sponsored
  };
}

export function parseLiveDirectItemUrl(rawUrl: string | null): Omit<ParsedLiveItemUrl, "sponsored"> {
  const parsed = parseLiveItemUrl(rawUrl);
  if (parsed.sponsored) return profileError();
  return { platformItemId: parsed.platformItemId, url: parsed.url };
}
