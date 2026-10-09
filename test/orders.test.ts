import { describe, expect, it } from "vitest";
import { createHarness, order } from "./helpers.ts";

describe("order ingestion", () => {
  it("creates the sale and attributes it by coupon", async () => {
    const h = createHarness();
    const res = await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }] }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "created", order_id: "1001", creator_id: "cr_ana", rule: "coupon" });

    const view = (await h.get("/orders/1001")).body;
    expect(view.order).toMatchObject({ currency: "BRL", total_cents: 10000, created_at: "2026-03-10T13:00:00.000Z" });
    expect(view.ledger).toHaveLength(1);
    expect(view.ledger[0]).toMatchObject({ kind: "sale", amount_cents: 10000, creator_id: "cr_ana" });
    expect(view.totals).toEqual({ gross_cents: 10000, refunded_cents: 0, reversed_cents: 0, net_cents: 10000 });
  });

  it("parses total_price exactly", async () => {
    const h = createHarness();
    await h.sendOrder(order({ total_price: "199.90" }));
    expect((await h.get("/orders/1001")).body.order.total_cents).toBe(19990);
  });

  it("same delivery id retried: one sale", async () => {
    const h = createHarness();
    const first = await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }] }), "d-1");
    const retry = await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }] }), "d-1");
    expect(first.status).toBe(201);
    expect(retry).toMatchObject({ status: 200, body: { status: "duplicate_delivery" } });

    const view = (await h.get("/orders/1001")).body;
    expect(view.ledger.filter((e: any) => e.kind === "sale")).toHaveLength(1);
    expect((await h.get("/creators/cr_ana/sales")).body.totals[0]).toMatchObject({ orders: 1, gross_cents: 10000 });
  });

  it("same order sent under a new delivery id: still one sale", async () => {
    const h = createHarness();
    await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }] }), "d-1");
    const again = await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }] }), "d-2");
    expect(again).toMatchObject({ status: 200, body: { status: "duplicate_order", creator_id: "cr_ana" } });

    expect((await h.get("/orders/1001")).body.ledger).toHaveLength(1);
    expect((await h.get("/creators/cr_ana/sales")).body.totals[0]).toMatchObject({ orders: 1, gross_cents: 10000, net_cents: 10000 });
  });

  it("works without a delivery id header; the order id still dedups", async () => {
    const h = createHarness();
    await h.sendOrder(order(), null);
    expect((await h.sendOrder(order(), null)).body.status).toBe("duplicate_order");
  });

  it("identical deliveries fired at the same time record one sale", async () => {
    const h = createHarness();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.sendOrder(order({ discount_codes: [{ code: "BIA15" }] }), `burst-${i}`)));
    expect(results.filter((r) => r.body.status === "created")).toHaveLength(1);
    expect((await h.get("/creators/cr_bia/sales")).body.totals[0]).toMatchObject({ orders: 1, gross_cents: 10000 });
  });

  it("order id as number and as string is the same order", async () => {
    const h = createHarness();
    await h.sendOrder(order({ id: 1001 }));
    expect((await h.sendOrder(order({ id: "1001" }))).body.status).toBe("duplicate_order");
  });

  it("keeps 64-bit Shopify ids exact", async () => {
    const h = createHarness();
    const raw = JSON.stringify(order()).replace('"id":1001', '"id":820982911946154508');
    const res = await h.send("/webhooks/orders", raw);
    expect(res.body.order_id).toBe("820982911946154508");
  });

  describe("tie-break end to end: coupon and UTM point to different creators", () => {
    it("credits the coupon's creator only and records the conflict", async () => {
      const h = createHarness();
      await h.sendOrder(order({ discount_codes: [{ code: "ANA10" }], landing_site: "/?utm_source=conty&utm_content=bia" }));

      const view = (await h.get("/orders/1001")).body;
      expect(view.attribution).toMatchObject({ creator_id: "cr_ana", rule: "coupon" });
      expect(view.attribution.conflicts.map((c: any) => c.creator_id)).toEqual(["cr_ana", "cr_bia"]);
      expect(view.attribution.evidence.utm).toEqual({ source: "conty", campaign: null, content: "bia" });

      expect((await h.get("/creators/cr_ana/sales")).body.totals[0].net_cents).toBe(10000);
      expect((await h.get("/creators/cr_bia/sales")).body.totals).toEqual([]);
    });
  });

  it("attributes by UTM from note_attributes", async () => {
    const h = createHarness();
    await h.sendOrder(order({ landing_site: null, note_attributes: [{ name: "utm_content", value: "caio" }] }));
    expect((await h.get("/orders/1001")).body.attribution).toMatchObject({ creator_id: "cr_caio", rule: "utm" });
  });

  it("no signal: unattributed, in no creator's totals, but still has a ledger", async () => {
    const h = createHarness();
    await h.sendOrder(order({ discount_codes: [{ code: "WELCOME5" }] }));

    const view = (await h.get("/orders/1001")).body;
    expect(view.attribution).toMatchObject({ creator_id: null, rule: "none" });
    expect(view.attribution.evidence.coupons).toEqual([{ code: "WELCOME5", creator_id: null }]);
    expect(view.ledger[0]).toMatchObject({ kind: "sale", creator_id: null });
    for (const id of ["cr_ana", "cr_bia", "cr_caio"]) expect((await h.get(`/creators/${id}/sales`)).body.orders).toEqual([]);
  });

  it("freezes the attribution at first ingest", async () => {
    const h = createHarness();
    await h.sendOrder(order({ landing_site: "/?utm_content=ana" }));
    const updated = await h.sendOrder(order({ financial_status: "paid", discount_codes: [{ code: "BIA15" }], landing_site: "/?utm_content=caio" }));
    expect(updated.body).toMatchObject({ status: "duplicate_order", creator_id: "cr_ana" });

    const view = (await h.get("/orders/1001")).body;
    expect(view.attribution).toMatchObject({ creator_id: "cr_ana", rule: "utm" });
    expect(view.ledger).toHaveLength(1);
  });

  it("a later update does not change the sale value", async () => {
    const h = createHarness();
    await h.sendOrder(order({ landing_site: "/?utm_content=ana" }));
    await h.sendOrder(order({ total_price: "500.00", landing_site: "/?utm_content=ana" }));
    expect((await h.get("/creators/cr_ana/sales")).body.totals[0].gross_cents).toBe(10000);
  });

  describe("cancellation", () => {
    it("a cancel update reverses what is left, once", async () => {
      const h = createHarness();
      await h.sendOrder(order({ landing_site: "/?utm_content=ana" }));
      const cancel = order({ landing_site: "/?utm_content=ana", cancelled_at: "2026-03-11T10:00:00Z", financial_status: "voided" });
      expect((await h.sendOrder(cancel)).body).toMatchObject({ status: "duplicate_order", cancelled_now: true });
      expect((await h.sendOrder(cancel)).body).toMatchObject({ status: "duplicate_order", cancelled_now: false });

      const view = (await h.get("/orders/1001")).body;
      expect(view.ledger.map((e: any) => [e.kind, e.amount_cents])).toEqual([["sale", 10000], ["reversal", -10000]]);
      expect(view.order.cancelled_at).toBe("2026-03-11T10:00:00.000Z");
      expect((await h.get("/creators/cr_ana/sales")).body.totals[0]).toMatchObject({ gross_cents: 10000, reversed_cents: 10000, net_cents: 0 });
    });

    it("reverses only the unrefunded rest", async () => {
      const h = createHarness();
      await h.sendOrder(order({ landing_site: "/?utm_content=ana" }));
      await h.sendRefund({ id: 1, order_id: 1001, created_at: "2026-03-11T00:00:00Z", transactions: [{ amount: "40.00", kind: "refund" }] });
      await h.sendOrder(order({ landing_site: "/?utm_content=ana", cancelled_at: "2026-03-12T10:00:00Z" }));

      const totals = (await h.get("/orders/1001")).body.totals;
      expect(totals).toEqual({ gross_cents: 10000, refunded_cents: 4000, reversed_cents: 6000, net_cents: 0 });
    });

    it("an order that arrives already cancelled is sale + reversal", async () => {
      const h = createHarness();
      await h.sendOrder(order({ financial_status: "voided", landing_site: "/?utm_content=ana" }));
      const view = (await h.get("/orders/1001")).body;
      expect(view.ledger.map((e: any) => e.kind)).toEqual(["sale", "reversal"]);
      expect(view.totals.net_cents).toBe(0);
    });

    it("a stale 'paid' update after cancellation does not revive the order", async () => {
      const h = createHarness();
      await h.sendOrder(order({ cancelled_at: "2026-03-11T10:00:00Z" }));
      await h.sendOrder(order({ cancelled_at: null, financial_status: "paid" }));
      const view = (await h.get("/orders/1001")).body;
      expect(view.order.cancelled_at).not.toBeNull();
      expect(view.totals.net_cents).toBe(0);
    });

    it("financial_status refunded alone does not move money; refund webhooks do", async () => {
      const h = createHarness();
      await h.sendOrder(order({ financial_status: "refunded" }));
      expect((await h.get("/orders/1001")).body.totals.net_cents).toBe(10000);
    });
  });
});
