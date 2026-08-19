const YUAN_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function moneyFromYuan(value: string): number {
  const match = YUAN_AMOUNT.exec(value.trim());

  if (!match) {
    throw new TypeError(`Expected a valid yuan amount, received: ${value}`);
  }

  const yuan = Number.parseInt(match[1]!, 10);
  const decimal = (match[2] ?? "").padEnd(2, "0");
  const fen = decimal === "" ? 0 : Number.parseInt(decimal, 10);
  const total = yuan * 100 + fen;

  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`Yuan amount is outside the supported range: ${value}`);
  }

  return total;
}
