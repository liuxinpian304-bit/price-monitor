export type MatchCategory = "BARE" | "BUNDLE" | "REJECTED" | "MANUAL";

export interface MonitoredProductRule {
  brand: string;
  standardModel: string;
  version: string | null;
  comparisonType: "BARE" | "BUNDLE";
  effectiveAliases: string[];
  excludedAliases: string[];
  mustIncludeTerms: string[];
  excludedTerms: string[];
}

export interface MatchDecision {
  category: MatchCategory;
  comparable: boolean;
  confidence: number;
  reasons: string[];
  normalizedModel: string | null;
}
