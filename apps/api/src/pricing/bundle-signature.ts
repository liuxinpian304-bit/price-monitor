import { createHash } from "node:crypto";

export interface BundleComparableItem {
  accessoryType: string;
  brand: string | null;
  modelOrName: string;
  quantity: number;
  unitValueFen: number;
  core: boolean;
}

function normalized(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function validateItem(item: BundleComparableItem): void {
  if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
    throw new TypeError("套装数量必须是正整数");
  }
  if (!Number.isSafeInteger(item.unitValueFen) || item.unitValueFen < 0) {
    throw new TypeError("套装单件标准价值必须是非负整数分");
  }
}

export function bundleSignature(items: BundleComparableItem[]): string {
  if (items.length === 0) {
    throw new TypeError("套装至少需要一个配件");
  }
  items.forEach(validateItem);

  const coreItems = items.some((item) => item.core) ? items.filter((item) => item.core) : items;
  const canonical = coreItems
    .map((item) => ({
      accessoryType: normalized(item.accessoryType),
      brand: normalized(item.brand),
      modelOrName: normalized(item.modelOrName),
      quantity: item.quantity
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `bundle-v1:${digest}`;
}

export function bundleReferencePriceFen(
  payableFen: number,
  items: BundleComparableItem[]
): number {
  if (!Number.isSafeInteger(payableFen) || payableFen < 0) {
    throw new TypeError("套装到手价必须是非负整数分");
  }

  let accessoryValueFen = 0;
  for (const item of items) {
    validateItem(item);
    accessoryValueFen += item.quantity * item.unitValueFen;
    if (!Number.isSafeInteger(accessoryValueFen)) {
      throw new RangeError("套装配件价值超出安全范围");
    }
  }

  return Math.max(0, payableFen - accessoryValueFen);
}
