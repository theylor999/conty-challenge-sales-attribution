import { describe, expect, it } from "vitest";
import { isCancelled, planRefund, summarize } from "../src/domain/ledger.ts";

describe("planRefund", () => {
  it("applies a refund that fits", () => {
    expect(planRefund(10000, 3000)).toEqual({ status: "applied", appliedCents: 3000, excessCents: 0 });
  });
  it("applies exactly the remaining amount", () => {
    expect(planRefund(7000, 7000)).toEqual({ status: "applied", appliedCents: 7000, excessCents: 0 });
  });
  it("caps at the remaining amount and keeps the excess", () => {
    expect(planRefund(7000, 8000)).toEqual({ status: "capped", appliedCents: 7000, excessCents: 1000 });
  });
  it("rejects when nothing is left", () => {
    expect(planRefund(0, 500)).toEqual({ status: "rejected", appliedCents: 0, excessCents: 500 });
  });
});

describe("summarize", () => {
  it("separates gross, refunded and reversed", () => {
    expect(
      summarize([
        { kind: "sale", amount_cents: 10000 },
        { kind: "refund", amount_cents: -2500 },
        { kind: "reversal", amount_cents: -7500 },
      ]),
    ).toEqual({ gross_cents: 10000, refunded_cents: 2500, reversed_cents: 7500, net_cents: 0 });
  });
});

describe("isCancelled", () => {
  it("treats cancelled_at and voided as cancelled, refunded as not", () => {
    expect(isCancelled({ cancelledAt: "2026-03-10T00:00:00.000Z", financialStatus: "paid" })).toBe(true);
    expect(isCancelled({ cancelledAt: null, financialStatus: "voided" })).toBe(true);
    expect(isCancelled({ cancelledAt: null, financialStatus: "refunded" })).toBe(false);
  });
});
