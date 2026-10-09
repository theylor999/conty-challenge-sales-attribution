export class InvalidMoneyError extends Error {}

// 13 integer digits keep cents below Number.MAX_SAFE_INTEGER.
const DECIMAL = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** Parses a non-negative decimal string ("199.90") into integer cents without float math. */
export function parseMoney(value: string): number {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new InvalidMoneyError(`invalid money amount: ${JSON.stringify(value)}`);
  const whole = match[1]!;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(whole) * 100 + Number(fraction);
}
