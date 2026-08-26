import type {
  CollectedSku,
  CollectedSkuComponent,
  PromotionEvidence,
  SearchTerminationReason
} from "@stau-price-monitor/contracts";

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
  appInstalled: boolean;
  accessibilityTrusted: boolean;
  screenRecordingTrusted: boolean;
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

export interface DriverSearchResult {
  positions: DriverSearchPosition[];
  terminationReason: SearchTerminationReason;
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
  components?: CollectedSkuComponent[];
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
  search(query: string, limit: number): Promise<DriverSearchResult>;
  openSearchPosition(position: DriverSearchPosition): Promise<DriverItemPage>;
  selectSku(selection: SkuSelection): Promise<DriverSkuSelectionResult>;
  returnToSearch(): Promise<void>;
}

export class LoginRequiredError extends Error {}
export class PlatformChallengeError extends Error {}
export class UiContractChangedError extends Error {}

export type DriverIssueCode =
  | "MISSING_ITEM_ID"
  | "APP_VERSION_UNSUPPORTED"
  | "TAOBAO_NOT_INSTALLED"
  | "TAOBAO_NOT_RUNNING"
  | "ACCESSIBILITY_PERMISSION_REQUIRED"
  | "SCREEN_RECORDING_PERMISSION_REQUIRED";

export class DriverIssueError extends Error {
  readonly code: DriverIssueCode;

  constructor(code: DriverIssueCode, message: string) {
    super(message);
    this.name = "DriverIssueError";
    this.code = code;
  }
}

export type DriverSkuIssueCode = "SKU_SELECTION_MISMATCH" | "PRICE_UNSTABLE";

export class DriverSkuIssueError extends Error {
  readonly code: DriverSkuIssueCode;

  constructor(code: DriverSkuIssueCode, message: string) {
    super(message);
    this.name = "DriverSkuIssueError";
    this.code = code;
  }
}
