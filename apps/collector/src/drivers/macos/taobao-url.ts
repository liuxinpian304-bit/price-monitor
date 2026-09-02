import { resolveItemUrlIdentity } from "@stau-price-monitor/contracts";

import { UiContractChangedError } from "../../core/desktop-driver.ts";

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";
const SHOP_HOST_SEGMENTS = new Set(["shop", "store", "seller"]);
const LIVE_PLATFORM_HOST_SUFFIXES = ["taobao.com", "tmall.com"];

export interface ParsedLiveItemUrl {
  platformItemId: string | null;
  url: string;
  sponsored: boolean;
}

function isLivePlatformHost(host: string): boolean {
  return LIVE_PLATFORM_HOST_SUFFIXES.some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`));
}

export function isSupportedLiveShopUrl(rawUrl: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return isLivePlatformHost(host)
      && host.split(".").some((segment) => SHOP_HOST_SEGMENTS.has(segment));
  } catch {
    return false;
  }
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
  try {
    return resolveItemUrlIdentity(parsed.toString(), null);
  } catch {
    return profileError();
  }
}

export function parseLiveItemUrl(rawUrl: string | null): ParsedLiveItemUrl {
  const parsed = parseUrl(rawUrl);
  const kind = liveItemUrlKind(parsed);
  if (kind === null) return profileError();
  const sponsored = kind === "SPONSORED";
  let identity: ReturnType<typeof resolveItemUrlIdentity>;
  try {
    identity = resolveItemUrlIdentity(parsed.toString(), null);
  } catch {
    return profileError();
  }
  if (sponsored && identity.platformItemId === null) return profileError();
  return {
    ...identity,
    sponsored
  };
}

export function parseLiveDirectItemUrl(rawUrl: string | null): Omit<ParsedLiveItemUrl, "sponsored"> {
  const parsed = parseLiveItemUrl(rawUrl);
  if (parsed.sponsored) return profileError();
  return { platformItemId: parsed.platformItemId, url: parsed.url };
}
