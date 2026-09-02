import type { SkuDimension, SkuSelection } from "./desktop-driver.ts";

function validateDimensions(dimensions: SkuDimension[]): void {
  const dimensionNames = new Set<string>();

  for (const dimension of dimensions) {
    if (dimensionNames.has(dimension.name)) {
      throw new TypeError(`Duplicate SKU dimension name: ${dimension.name}`);
    }
    dimensionNames.add(dimension.name);

    const labels = new Set<string>();
    for (const option of dimension.options) {
      if (labels.has(option.label)) {
        throw new TypeError(`Duplicate SKU option label in ${dimension.name}: ${option.label}`);
      }
      labels.add(option.label);
    }
  }
}

export function enumerateSkuSelections(dimensions: SkuDimension[]): SkuSelection[] {
  validateDimensions(dimensions);

  let selections: SkuSelection[] = [{}];
  for (const dimension of dimensions) {
    const enabledOptions = dimension.options.filter((option) => option.enabled);
    const nextSelections: SkuSelection[] = [];

    for (const selection of selections) {
      for (const option of enabledOptions) {
        nextSelections.push({ ...selection, [dimension.name]: option.label });
      }
    }

    selections = nextSelections;
  }

  return selections;
}
