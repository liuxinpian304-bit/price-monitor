import type { CollectedSku, PromotionEvidence } from "@stau-price-monitor/contracts";

export type DriverEvidenceValue =
  | string
  | number
  | boolean
  | null
  | DriverEvidenceValue[]
  | { [key: string]: DriverEvidenceValue };

export interface DriverRawEvidence {
  source: string;
  capturedAt: string;
  metadata: DriverEvidenceValue;
}

export interface DriverDiagnostic {
  accessibilityTrusted: boolean;
  appRunning: boolean;
  processId: number | null;
  bundleId: string;
  appVersion: string | null;
  appBuild: string | null;
  hasFrontWindow: boolean;
  loginState: "LOGGED_IN" | "LOGGED_OUT" | "UNKNOWN";
  rawEvidence: DriverRawEvidence;
}

export interface DriverSearchPosition {
  rank: number;
  platformItemId: string | null;
  url: string;
  shopName: string;
  title: string;
  displayPriceMinText: string | null;
  displayPriceMaxText: string | null;
  sponsored: boolean;
  capturedAt: string;
  rawEvidence: DriverRawEvidence;
}

export interface SkuOption {
  id: string;
  label: string;
  enabled: boolean;
}

export interface SkuDimension {
  name: string;
  options: SkuOption[];
}

export type SkuSelection = Record<string, string>;

export interface DriverItemPage {
  platformItemId: string | null;
  url: string;
  shopName: string;
  title: string;
  skuDimensions: SkuDimension[];
  pageSkuCount?: number;
  rawEvidence: DriverRawEvidence;
}

export interface DriverSkuView {
  selectedLabels: SkuSelection;
  listPriceText: string | null;
  activityPriceText: string | null;
  officialEstimatedPayablePriceText: string | null;
  promotions: PromotionEvidence[];
  mandatoryFeeText: string | null;
  stockState: CollectedSku["stockState"];
  capturedAt: string;
  rawEvidence: DriverRawEvidence;
  evidencePath?: string;
}

export type DriverSkuSelectionResult =
  | { availability: "AVAILABLE"; view: DriverSkuView }
  | { availability: "UNAVAILABLE"; reason: string };

export interface TaobaoDesktopDriver {
  diagnose(): Promise<DriverDiagnostic>;
  openOwnListing(url: string): Promise<DriverItemPage>;
  search(query: string, limit: number): Promise<DriverSearchPosition[]>;
  openSearchPosition(position: DriverSearchPosition): Promise<DriverItemPage>;
  selectSku(selection: SkuSelection): Promise<DriverSkuSelectionResult>;
  returnToSearch(): Promise<void>;
}

export class LoginRequiredError extends Error {}
export class PlatformChallengeError extends Error {}
export class UiContractChangedError extends Error {}
