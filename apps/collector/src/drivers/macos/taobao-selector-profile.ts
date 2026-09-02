import { UiContractChangedError } from "../../core/desktop-driver.ts";
import { walkAxNodes, type AxNode } from "./ax-node.ts";

export const APPROVED_TAOBAO_SELECTOR_PROFILE = "taobao-desktop-2.4.5-build-15";
export type TaobaoSelectorProfile = "SYNTHETIC" | "LIVE";

const RESERVED_SYNTHETIC_IDENTIFIERS = new Set([
  "search-region",
  "search-result-list",
  "search-result-query-marker",
  "result-card",
  "item-detail-window",
  "item-header",
  "sku-region",
  "sku-dimension",
  "selected-sku-price",
  "selected-sku-promotions",
  "navigation-back",
  "login-required-dialog",
  "platform-challenge-dialog"
]);

const PROFILE_ERROR = "Taobao Accessibility tree does not match the approved 2.4.5 build 15 profile";

type RuntimeFixtureMetadata = {
  kind?: unknown;
  profile?: unknown;
};

function profileError(): never {
  throw new UiContractChangedError(PROFILE_ERROR);
}

function runtimeFixtureMetadata(root: AxNode): RuntimeFixtureMetadata | null {
  const metadata = (root as AxNode & { fixtureMetadata?: unknown }).fixtureMetadata;
  if (metadata === undefined) return null;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return profileError();
  return metadata as RuntimeFixtureMetadata;
}

export function taobaoSelectorProfile(root: AxNode): TaobaoSelectorProfile {
  const metadata = runtimeFixtureMetadata(root);
  const hasReservedMarker = walkAxNodes(root).some((node) =>
    typeof node.identifier === "string" && RESERVED_SYNTHETIC_IDENTIFIERS.has(node.identifier));

  if (!metadata) {
    return hasReservedMarker ? profileError() : "LIVE";
  }
  if (metadata.profile !== APPROVED_TAOBAO_SELECTOR_PROFILE) return profileError();
  if (metadata.kind === "synthetic-sanitized") {
    return hasReservedMarker ? "SYNTHETIC" : profileError();
  }
  if (metadata.kind === "live-sanitized") {
    return hasReservedMarker ? profileError() : "LIVE";
  }
  return profileError();
}
