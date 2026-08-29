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
  const host = parsed.hostname.toLowerCase();
  const direct = host === "detail.tmall.com" || host === "item.taobao.com";
  const sponsored = host.endsWith(".simba.taobao.com");
  if (!direct && !sponsored) return profileError();
  return {
    platformItemId: stableItemId(parsed, sponsored),
    url: canonicalUrl(parsed),
    sponsored
  };
}
