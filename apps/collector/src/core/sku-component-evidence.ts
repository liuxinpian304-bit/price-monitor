import type { CollectedSkuComponent } from "@stau-price-monitor/contracts";

export interface SkuComponentEvidenceInput {
  brand: string;
  standardModel: string;
  selectedLabels: Record<string, string>;
  explicitComponents: CollectedSkuComponent[] | undefined;
}

const COLOR_DIMENSION_PATTERN = /颜色|色号/u;
const QUANTITY_DIMENSION_PATTERN = /数量|只数|件数/u;
const QUANTITY_TOKEN_PATTERN = /(\d+)\s*(?:只|件|个|套)/gu;
const PACKAGE_SEPARATOR_PATTERN = /\s*(?:\+|＋|\/|、|搭配)\s*/u;
const GIFT_OR_SERVICE_PATTERN = /赠|免费|调试|安装|软件|驱动|保养/u;
const ACCESSORY_TYPE_PATTERN = /声卡|支架|耳机|音箱|线材|防喷|话放|麦克风/u;
const ALPHANUMERIC_TOKEN_PATTERN = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/gu;
const SINGLE_PRODUCT_LABELS = new Set(["单麦克风", "单机", "单品", "裸机"]);
const POSTGRES_INT_MAX = 2_147_483_647;

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, "").toLocaleLowerCase("en-US");
}

function unambiguousQuantity(label: string): number | undefined {
  const matches = [...label.matchAll(QUANTITY_TOKEN_PATTERN)];
  if (matches.length !== 1) return undefined;
  const quantity = Number(matches[0]?.[1]);
  return Number.isInteger(quantity) && quantity > 0 && quantity <= POSTGRES_INT_MAX
    ? quantity
    : undefined;
}

function modelLikeIdentifier(token: string): string | undefined {
  return token.match(ALPHANUMERIC_TOKEN_PATTERN)
    ?.find((candidate) => /[A-Za-z]/u.test(candidate) && /\d/u.test(candidate));
}

function deduplicate(components: CollectedSkuComponent[]): CollectedSkuComponent[] {
  const keys = new Set<string>();
  return components.filter((component) => {
    const key = JSON.stringify([
      component.role,
      normalized(component.accessoryType),
      component.brand === null ? null : normalized(component.brand),
      normalized(component.modelOrName),
      component.quantity
    ]);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function deriveSkuComponents(
  input: SkuComponentEvidenceInput
): CollectedSkuComponent[] {
  if (input.explicitComponents !== undefined && input.explicitComponents.length > 0) {
    return structuredClone(input.explicitComponents);
  }

  const core: CollectedSkuComponent = {
    role: "CORE",
    accessoryType: "核心产品",
    brand: input.brand,
    modelOrName: input.standardModel,
    quantity: 1
  };
  const components: CollectedSkuComponent[] = [core];

  for (const [dimension, label] of Object.entries(input.selectedLabels)) {
    if (QUANTITY_DIMENSION_PATTERN.test(dimension)) {
      core.quantity = unambiguousQuantity(label) ?? core.quantity;
      continue;
    }
    if (COLOR_DIMENSION_PATTERN.test(dimension)) continue;

    for (const rawToken of label.split(PACKAGE_SEPARATOR_PATTERN)) {
      const token = rawToken.trim();
      if (token.length === 0
        || normalized(token) === normalized(input.standardModel)
        || SINGLE_PRODUCT_LABELS.has(normalized(token))) {
        continue;
      }

      if (GIFT_OR_SERVICE_PATTERN.test(token)) {
        components.push({
          role: "GIFT_OR_SERVICE",
          accessoryType: "赠品或服务",
          brand: null,
          modelOrName: token,
          quantity: 1
        });
        continue;
      }

      const accessoryType = token.match(ACCESSORY_TYPE_PATTERN)?.[0];
      const identifier = modelLikeIdentifier(token);
      if (accessoryType !== undefined && identifier !== undefined) {
        components.push({
          role: "PAID_ACCESSORY",
          accessoryType,
          brand: null,
          modelOrName: identifier,
          quantity: 1
        });
        continue;
      }

      components.push({
        role: "UNKNOWN",
        accessoryType: "未知套餐内容",
        brand: null,
        modelOrName: token,
        quantity: 1
      });
    }
  }

  return deduplicate(components);
}
