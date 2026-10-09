import { describe, expect, it } from "vitest";
import { createHarness, order, refund } from "./helpers.ts";

describe("input validation", () => {
  it.each([
    ["total_price as a number", { total_price: 199.9 }],
    ["total_price with 3 decimals", { total_price: "10.999" }],
    ["negative total", { total_price: "-5.00" }],
    ["missing id", { id: undefined }],
    ["bad currency", { currency: "REAL" }],
    ["bad created_at", { created_at: "yesterday" }],
  ])("order: rejects %s with 422", async (_name, patch) => {
    const h = createHarness();
    const res = await h.sendOrder(order(patch));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_payload");
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders")!.n).toBe(0);
  });

  it.each([
    ["no transactions array", { transactions: undefined }],
    ["amount as number", { transactions: [{ amount: 10, kind: "refund" }] }],
    ["missing order_id", { order_id: undefined }],
    ["mixed currencies", { transactions: [{ amount: "1.00", kind: "refund", currency: "BRL" }, { amount: "1.00", kind: "refund", currency: "USD" }] }],
  ])("refund: rejects %s with 422", async (_name, patch) => {
    const res = await createHarness().sendRefund(refund(patch));
    expect(res.status).toBe(422);
  });

  it("rejects invalid JSON with 400", async () => {
    expect((await createHarness().send("/webhooks/orders", "{nope")).status).toBe(400);
  });

  it("a refund without refund money is ignored, not stored", async () => {
    const h = createHarness();
    const res = await h.sendRefund(refund({ transactions: [] }));
    expect(res).toMatchObject({ status: 200, body: { status: "ignored" } });
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM refunds")!.n).toBe(0);
  });

  it("a failed validation does not burn the delivery id", async () => {
    const h = createHarness();
    expect((await h.sendOrder(order({ total_price: "x" }), "d-1")).status).toBe(422);
    expect((await h.sendOrder(order(), "d-1")).status).toBe(201);
  });
});

describe("read endpoints", () => {
  it("404 for unknown order and creator", async () => {
    const h = createHarness();
    expect((await h.get("/orders/999")).status).toBe(404);
    expect((await h.get("/creators/cr_nobody/sales")).status).toBe(404);
  });

  it("a creator without sales has empty totals", async () => {
    expect((await createHarness().get("/creators/cr_ana/sales")).body).toEqual({ creator_id: "cr_ana", name: "Ana Lima", totals: [], orders: [] });
  });
});

describe("HMAC", () => {
  const secret = "test-secret";

  it("accepts a correctly signed body", async () => {
    const h = createHarness({ webhookSecret: secret });
    const raw = JSON.stringify(order());
    const res = await h.send("/webhooks/orders", raw, { "x-shopify-hmac-sha256": h.sign(raw) });
    expect(res.status).toBe(201);
  });

  it("rejects missing, wrong and tampered signatures without storing anything", async () => {
    const h = createHarness({ webhookSecret: secret });
    const raw = JSON.stringify(order());
    const signature = h.sign(raw);
    expect((await h.send("/webhooks/orders", raw)).status).toBe(401);
    expect((await h.send("/webhooks/orders", raw, { "x-shopify-hmac-sha256": "AAAA" })).status).toBe(401);
    expect((await h.send("/webhooks/orders", raw.replace("100.00", "1.00"), { "x-shopify-hmac-sha256": signature })).status).toBe(401);
    expect((await h.send("/webhooks/refunds", JSON.stringify(refund()), { "x-shopify-hmac-sha256": signature })).status).toBe(401);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders")!.n).toBe(0);
  });
});
