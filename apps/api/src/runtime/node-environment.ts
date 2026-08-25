export function normalizeNodeEnvironment(value: string | undefined): string {
  return value?.trim().toLowerCase() || "development";
}

export function isProductionEnvironment(value: string | undefined): boolean {
  return normalizeNodeEnvironment(value) === "production";
}
