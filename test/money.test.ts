import { describe, expect, it } from "vitest";
import { InvalidMoneyError, parseMoney } from "../src/domain/money.ts";

describe("parseMoney", () => {
  it.each([
    ["199.90", 19990],
    ["0.10", 10],
    ["0.1", 10],
    ["0.07", 7],
    ["50", 5000],
    ["0.00", 0],
    ["19.99", 1999],
    ["1234567.89", 123456789],
  ])("%s -> %i cents, exactly", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each(["", "-1.00", "1,50", "1.999", ".5", "5.", "abc", "1e3", "NaN", "10000000000000"])("rejects %j", (input) => {
    expect(() => parseMoney(input)).toThrow(InvalidMoneyError);
  });
});
