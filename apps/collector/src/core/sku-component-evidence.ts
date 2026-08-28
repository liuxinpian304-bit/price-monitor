import type { CollectedSkuComponent } from "@stau-price-monitor/contracts";

export interface SkuComponentEvidenceInput {
  brand: string;
  standardModel: string;
  selectedLabels: Record<string, string>;
  explicitComponents: CollectedSkuComponent[] | undefined;
}

const COLOR_DIMENSION_PATTERN = /颜色|色号/u;
const MATERIAL_ATTRIBUTE_DIMENSION_PATTERN = /版本|区域|地区|国行|保修|质保/u;
const QUANTITY_DIMENSION_PATTERN = /数量|只数|件数/u;
const QUANTITY_TOKEN_PATTERN = /(?<![\d.+\-−])([1-9]\d*)(?![\d.])\s*(?:只|件|个|套)/gu;
const QUANTITY_EVIDENCE_PATTERN = /[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:只|件|个|套)/gu;
const PACKAGE_SEPARATOR_PATTERN = /\s*(?:\+|＋|\/|、|搭配)\s*/u;
const GIFT_OR_SERVICE_PATTERN = /赠|免费|调试|安装|软件|驱动|保养/u;
const ACCESSORY_TYPE_PATTERN = /声卡|支架|耳机|音箱|线材|防喷|话放|麦克风/u;
const ALPHANUMERIC_TOKEN_PATTERN = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/gu;
const SINGLE_PRODUCT_LABELS = new Set(["单麦克风", "单机", "单品", "裸机"]);
const CORE_PRODUCT_DESCRIPTORS = new Set(["麦克风", "耳机", "音箱", "声卡", "话放"]);
const POSTGRES_INT_MAX = 2_147_483_647;

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, "").toLocaleLowerCase("en-US");
}

function unambiguousQuantity(label: string): number | undefined {
  const numericEvidence = label.normalize("NFKC");
  const matches = [...numericEvidence.matchAll(QUANTITY_TOKEN_PATTERN)];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const matchStart = match.index;
  if (matchStart === undefined) return undefined;
  const beforeMatch = numericEvidence.slice(0, matchStart);
  const afterMatch = numericEvidence.slice(matchStart + match[0].length);
  if (/\d/u.test(`${beforeMatch}${afterMatch}`) || /[.+\-−]$/u.test(beforeMatch.trimEnd())) {
    return undefined;
  }

  const quantity = Number(match[1]);
  return Number.isInteger(quantity) && quantity > 0 && quantity <= POSTGRES_INT_MAX
    ? quantity
    : undefined;
}

function componentTokenQuantity(rawToken: string):
  | { kind: "VALID"; token: string; quantity: number }
  | { kind: "INVALID" } {
  const token = rawToken.normalize("NFKC").trim();
  const evidence = [...token.matchAll(QUANTITY_EVIDENCE_PATTERN)];
  if (evidence.length === 0) return { kind: "VALID", token, quantity: 1 };
  if (evidence.length !== 1) return { kind: "INVALID" };

  const match = evidence[0]!;
  const matchStart = match.index;
  if (matchStart === undefined || matchStart + match[0].length !== token.length) {
    return { kind: "INVALID" };
  }
  const quantity = unambiguousQuantity(match[0]);
  const componentToken = token.slice(0, matchStart).trim();
  if (quantity === undefined || componentToken.length === 0) return { kind: "INVALID" };
  return { kind: "VALID", token: componentToken, quantity };
}

function modelLikeIdentifiers(token: string): string[] {
  return token.match(ALPHANUMERIC_TOKEN_PATTERN)
    ?.filter((candidate) => /[A-Za-z]/u.test(candidate) && /\d/u.test(candidate)) ?? [];
}

function accessoryTypeForIdentifier(token: string, identifier: string): string | undefined {
  const identifierIndex = token.indexOf(identifier);
  if (identifierIndex < 0) return undefined;
  return token.slice(identifierIndex + identifier.length).match(ACCESSORY_TYPE_PATTERN)?.[0]
    ?? token.slice(0, identifierIndex).match(ACCESSORY_TYPE_PATTERN)?.[0];
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

function unknownQuantity(dimension: string, label: string): CollectedSkuComponent {
  return {
    role: "UNKNOWN",
    accessoryType: "数量归属未知",
    brand: null,
    modelOrName: `${dimension}: ${label}`,
    quantity: 1
  };
}

function quantityTarget(
  dimension: string,
  components: CollectedSkuComponent[],
  standardModel: string
): CollectedSkuComponent | undefined {
  const target = normalized(dimension.replace(/数量|只数|件数/gu, ""));
  if (target.length === 0) return undefined;

  const assignable = components.filter((component) =>
    component.role === "CORE" || component.role === "PAID_ACCESSORY");
  if (target.includes(normalized(standardModel))) {
    const core = assignable.filter((component) => component.role === "CORE");
    return core.length === 1 ? core[0] : undefined;
  }
  if (CORE_PRODUCT_DESCRIPTORS.has(target)) {
    const matchingPaidAccessories = assignable.filter((component) =>
      component.role === "PAID_ACCESSORY" && normalized(component.accessoryType) === target);
    if (matchingPaidAccessories.length > 0) return undefined;
    const core = assignable.filter((component) => component.role === "CORE");
    return core.length === 1 ? core[0] : undefined;
  }

  const matches = assignable.filter((component) => [component.accessoryType, component.modelOrName]
    .some((value) => {
      const evidence = normalized(value);
      return evidence.length > 0 && evidence !== normalized("核心产品")
        && (target.includes(evidence) || evidence.includes(target));
    }));
  return matches.length === 1 ? matches[0] : undefined;
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
  const coreIdentifiers = new Set(modelLikeIdentifiers(input.standardModel).map(normalized));
  const quantityDimensions: Array<{ dimension: string; label: string }> = [];

  for (const [dimension, label] of Object.entries(input.selectedLabels)) {
    if (QUANTITY_DIMENSION_PATTERN.test(dimension)) {
      quantityDimensions.push({ dimension, label });
      continue;
    }
    if (COLOR_DIMENSION_PATTERN.test(dimension)
      || MATERIAL_ATTRIBUTE_DIMENSION_PATTERN.test(dimension)) continue;

    for (const rawToken of label.split(PACKAGE_SEPARATOR_PATTERN)) {
      const parsedQuantity = componentTokenQuantity(rawToken);
      if (parsedQuantity.kind === "INVALID") {
        components.push({
          role: "UNKNOWN",
          accessoryType: "组件数量未知",
          brand: null,
          modelOrName: rawToken.trim(),
          quantity: 1
        });
        continue;
      }
      const { token, quantity } = parsedQuantity;
      if (token.length === 0
        || normalized(token) === normalized(input.standardModel)
        || SINGLE_PRODUCT_LABELS.has(normalized(token))) {
        if (quantity !== 1 && normalized(token) === normalized(input.standardModel)) {
          core.quantity = quantity;
        }
        continue;
      }

      if (GIFT_OR_SERVICE_PATTERN.test(token)) {
        components.push({
          role: "GIFT_OR_SERVICE",
          accessoryType: "赠品或服务",
          brand: null,
          modelOrName: token,
          quantity
        });
        continue;
      }

      const tokenIdentifiers = modelLikeIdentifiers(token);
      const matchedCoreIdentifiers = tokenIdentifiers.filter((identifier) =>
        coreIdentifiers.has(normalized(identifier)));
      const accessoryIdentifiers = tokenIdentifiers.filter((identifier) =>
        !coreIdentifiers.has(normalized(identifier)));
      if (matchedCoreIdentifiers.length > 0 && accessoryIdentifiers.length === 0) {
        const residual = matchedCoreIdentifiers.reduce(
          (value, identifier) => value.replace(identifier, ""),
          token
        );
        const normalizedResidual = normalized(residual);
        if (normalizedResidual.length === 0 || CORE_PRODUCT_DESCRIPTORS.has(normalizedResidual)) {
          if (core.quantity !== 1 && core.quantity !== quantity) {
            components.push(unknownQuantity(dimension, label));
          } else {
            core.quantity = quantity;
          }
          continue;
        }
        components.push({
          role: "UNKNOWN",
          accessoryType: "未知套餐内容",
          brand: null,
          modelOrName: token,
          quantity
        });
        continue;
      }

      const identifier = accessoryIdentifiers[0] ?? tokenIdentifiers[0];
      const accessoryType = identifier === undefined
        ? undefined
        : accessoryTypeForIdentifier(token, identifier);
      if (accessoryType !== undefined && identifier !== undefined) {
        components.push({
          role: "PAID_ACCESSORY",
          accessoryType,
          brand: null,
          modelOrName: identifier,
          quantity
        });
        continue;
      }

      components.push({
        role: "UNKNOWN",
        accessoryType: "未知套餐内容",
        brand: null,
        modelOrName: token,
        quantity
      });
    }
  }

  for (const { dimension, label } of quantityDimensions) {
    const quantity = unambiguousQuantity(label);
    const target = quantityTarget(dimension, components, input.standardModel);
    if (quantity === undefined || target === undefined
      || (target.quantity !== 1 && target.quantity !== quantity)) {
      components.push(unknownQuantity(dimension, label));
      continue;
    }
    target.quantity = quantity;
  }

  return deduplicate(components);
}
