const ITEM_ID_QUERY_NAMES = ["id", "item_id", "itemId"] as const;
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ItemUrlIdentity {
  url: string;
  platformItemId: string | null;
}

function validItemId(value: string): boolean {
  return ITEM_ID_PATTERN.test(value);
}

export function resolveItemUrlIdentity(
  rawUrl: string,
  observedPlatformItemId: string | null
): ItemUrlIdentity {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError("Invalid item URL identity");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Invalid item URL identity");
  }

  const urlItemIds = ITEM_ID_QUERY_NAMES.flatMap((name) => parsed.searchParams.getAll(name));
  if (urlItemIds.some((value) => !validItemId(value))) {
    throw new TypeError("Invalid item URL identity");
  }
  const distinctUrlItemIds = [...new Set(urlItemIds)];
  if (distinctUrlItemIds.length > 1) throw new TypeError("Conflicting item URL identity");

  if (observedPlatformItemId !== null && !validItemId(observedPlatformItemId)) {
    throw new TypeError("Invalid observed item identity");
  }
  const urlItemId = distinctUrlItemIds[0] ?? null;
  if (urlItemId !== null && observedPlatformItemId !== null
    && urlItemId !== observedPlatformItemId) {
    throw new TypeError("Conflicting observed item identity");
  }

  parsed.hash = "";
  parsed.searchParams.sort();
  return {
    url: parsed.toString(),
    platformItemId: observedPlatformItemId ?? urlItemId
  };
}
