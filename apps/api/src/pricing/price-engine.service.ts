export interface PriceAdjustment {
  label: string;
  amountFen: number | null;
}

export interface PriceInput {
  pagePriceFen: number | null;
  publicDiscounts: PriceAdjustment[];
  mandatoryFees: PriceAdjustment[];
  privatePriceRequired: boolean;
}

export interface PriceResult {
  payableFen: number | null;
  publicDiscountFen: number;
  confidence: "CONFIRMED" | "MANUAL";
  reasons: string[];
}

function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label}必须是非负整数分`);
  }
}

function knownTotal(adjustments: PriceAdjustment[], label: string): number | null {
  let total = 0;
  for (const adjustment of adjustments) {
    if (adjustment.amountFen === null) {
      return null;
    }
    assertMoney(adjustment.amountFen, `${label}“${adjustment.label}”`);
    total += adjustment.amountFen;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError(`${label}金额超出安全范围`);
    }
  }
  return total;
}

export class PriceEngineService {
  calculate(input: PriceInput): PriceResult {
    if (input.pagePriceFen !== null) {
      assertMoney(input.pagePriceFen, "页面价");
    }

    if (input.privatePriceRequired) {
      return {
        payableFen: null,
        publicDiscountFen: 0,
        confidence: "MANUAL",
        reasons: ["价格需要私聊或联系客服后才能确定，不能作为自动比价依据"]
      };
    }

    if (input.pagePriceFen === null) {
      return {
        payableFen: null,
        publicDiscountFen: 0,
        confidence: "MANUAL",
        reasons: ["缺少具体SKU页面价，不能使用搜索区间最低价代替"]
      };
    }

    const publicDiscountFen = knownTotal(input.publicDiscounts, "公开优惠");
    if (publicDiscountFen === null) {
      return {
        payableFen: null,
        publicDiscountFen: 0,
        confidence: "MANUAL",
        reasons: ["存在金额无法确认的公开优惠，需要人工核对适用条件"]
      };
    }

    const mandatoryFeeFen = knownTotal(input.mandatoryFees, "必付费用");
    if (mandatoryFeeFen === null) {
      return {
        payableFen: null,
        publicDiscountFen,
        confidence: "MANUAL",
        reasons: ["存在金额无法确认的必付费用，需要人工核对"]
      };
    }

    const payableFen = input.pagePriceFen - publicDiscountFen + mandatoryFeeFen;
    if (!Number.isSafeInteger(payableFen) || payableFen < 0) {
      return {
        payableFen: null,
        publicDiscountFen,
        confidence: "MANUAL",
        reasons: ["优惠或费用组合产生无效到手价，需要人工核对"]
      };
    }

    const reasons = [`具体SKU页面价 ${input.pagePriceFen} 分`];
    if (publicDiscountFen > 0) {
      reasons.push(`扣除公开优惠 ${publicDiscountFen} 分`);
    }
    if (mandatoryFeeFen > 0) {
      reasons.push(`加上必付费用 ${mandatoryFeeFen} 分`);
    }

    return {
      payableFen,
      publicDiscountFen,
      confidence: "CONFIRMED",
      reasons
    };
  }
}
