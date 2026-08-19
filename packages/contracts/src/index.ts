export const COMPARISON_TYPES = ["BARE", "BUNDLE"] as const;
export type ComparisonType = (typeof COMPARISON_TYPES)[number];

export const ALERT_STATUSES = [
  "PENDING",
  "PRICE_CHANGED",
  "NO_FOLLOW",
  "FALSE_POSITIVE",
  "WATCHING"
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
