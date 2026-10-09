import { describe, expect, it } from "vitest";
import { createHarness, order, refund } from "./helpers.ts";

const ana = order({ landing_site: "/?utm_content=ana" });
const sales = async (h: ReturnType<typeof createHarness>, id = "cr_ana") => (await h.get(`/creators/${id}/sales`)).body;

describe("partial refund", () => {
  it("reduces the creator's net and keeps the sale entry", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    const res = await h.sendRefund(refund({}, "30.00"));
    expect(res).toMatchObject({ status: 201, body: { status: "applied", refund: { applied_cents: 3000, excess_cents: 0 } } });

    const view = (await h.get("/orders/1001")).body;
    expect(view.ledger.map((e: any) => [e.kind, e.amount_cents, e.refund_id])).toEqual([["sale", 10000, null], ["refund", -3000, "5001"]]);
    expect(view.totals).toEqual({ gross_cents: 10000, refunded_cents: 3000, reversed_cents: 0, net_cents: 7000 });
    expect((await sales(h)).totals[0]).toMatchObject({ orders: 1, gross_cents: 10000, refunded_cents: 3000, net_cents: 7000 });
  });

  it("several partial refunds add up", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({ id: 1 }, "10.10"));
    await h.sendRefund(refund({ id: 2 }, "20.20"));
    expect((await h.get("/orders/1001")).body.totals).toMatchObject({ refunded_cents: 3030, net_cents: 6970 });
  });

  it("sums several refund transactions of one refund and ignores non-refund or failed ones", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(
      refund({
        transactions: [
          { amount: "10.00", kind: "refund", status: "success" },
          { amount: "5.50", kind: "refund" },
          { amount: "99.00", kind: "refund", status: "failure" },
          { amount: "99.00", kind: "capture" },
        ],
      }),
    );
    expect((await h.get("/orders/1001")).body.totals.refunded_cents).toBe(1550);
  });

  it("a full refund zeroes the net without deleting anything", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({}, "100.00"));
    const view = (await h.get("/orders/1001")).body;
    expect(view.totals).toMatchObject({ gross_cents: 10000, refunded_cents: 10000, net_cents: 0 });
    expect(view.ledger).toHaveLength(2);
    expect((await sales(h)).totals[0]).toMatchObject({ orders: 1, net_cents: 0 });
  });

  it("an unattributed order's refund never reaches a creator", async () => {
    const h = createHarness();
    await h.sendOrder(order());
    await h.sendRefund(refund({}, "10.00"));
    const view = (await h.get("/orders/1001")).body;
    expect(view.ledger[1]).toMatchObject({ kind: "refund", creator_id: null });
    expect((await sales(h)).orders).toEqual([]);
  });
});

describe("repeated refund", () => {
  it("same refund id under new deliveries is applied once", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({}, "30.00"));
    const again = await h.sendRefund(refund({}, "30.00"));
    expect(again).toMatchObject({ status: 200, body: { status: "duplicate_refund", refund: { applied_cents: 3000 } } });
    expect((await h.get("/orders/1001")).body.totals).toMatchObject({ refunded_cents: 3000, net_cents: 7000 });
  });

  it("same delivery id retried is applied once", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund(), "r-1");
    expect((await h.sendRefund(refund(), "r-1")).body.status).toBe("duplicate_delivery");
    expect((await h.get("/orders/1001")).body.ledger.filter((e: any) => e.kind === "refund")).toHaveLength(1);
  });

  it("a repeat carrying a different amount does not change the first one", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({}, "30.00"));
    await h.sendRefund(refund({}, "90.00"));
    expect((await h.get("/orders/1001")).body.totals.refunded_cents).toBe(3000);
  });

  it("refund id as number and as string is the same refund", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({ id: 5001 }));
    expect((await h.sendRefund(refund({ id: "5001" }))).body.status).toBe("duplicate_refund");
  });

  it("concurrent copies of one refund apply once", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.sendRefund(refund({}, "30.00"))));
    expect(results.map((r) => r.body.status).sort()).toEqual(["applied", ...Array(7).fill("duplicate_refund")]);
    expect((await h.get("/orders/1001")).body.totals.refunded_cents).toBe(3000);
  });
});

describe("refund cap", () => {
  it("different refunds summing above the total are capped, excess recorded", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    await h.sendRefund(refund({ id: 1 }, "70.00"));
    const second = await h.sendRefund(refund({ id: 2 }, "50.00"));
    expect(second.body).toMatchObject({ status: "capped", refund: { requested_cents: 5000, applied_cents: 3000, excess_cents: 2000, reason: "exceeds_remaining" } });

    const third = await h.sendRefund(refund({ id: 3 }, "1.00"));
    expect(third.body).toMatchObject({ status: "rejected", refund: { applied_cents: 0, excess_cents: 100, reason: "nothing_left" } });

    const view = (await h.get("/orders/1001")).body;
    expect(view.totals).toMatchObject({ refunded_cents: 10000, net_cents: 0 });
    expect(view.ledger.filter((e: any) => e.kind === "refund")).toHaveLength(2);
    expect(view.refunds.map((r: any) => r.status)).toEqual(["applied", "capped", "rejected"]);
  });

  it("one refund larger than the whole sale is capped at the sale", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    const res = await h.sendRefund(refund({}, "250.00"));
    expect(res.body.refund).toMatchObject({ status: "capped", applied_cents: 10000, excess_cents: 15000 });
    expect((await sales(h)).totals[0]).toMatchObject({ refunded_cents: 10000, net_cents: 0 });
  });

  it("a refund in another currency is rejected and moves no money", async () => {
    const h = createHarness();
    await h.sendOrder(ana);
    const res = await h.sendRefund({ ...refund(), transactions: [{ amount: "10.00", kind: "refund", currency: "USD" }] });
    expect(res.body).toMatchObject({ status: "rejected", refund: { reason: "currency_mismatch", applied_cents: 0 } });
    expect((await h.get("/orders/1001")).body.totals.net_cents).toBe(10000);
  });

  it("a refund after a cancellation has nothing left to take", async () => {
    const h = createHarness();
    await h.sendOrder(order({ landing_site: "/?utm_content=ana", cancelled_at: "2026-03-10T11:00:00Z" }));
    const res = await h.sendRefund(refund({}, "10.00"));
    expect(res.body).toMatchObject({ status: "rejected", refund: { excess_cents: 1000, reason: "nothing_left" } });
    expect((await h.get("/orders/1001")).body.totals).toMatchObject({ reversed_cents: 10000, refunded_cents: 0, net_cents: 0 });
  });
});

describe("refund before order", () => {
  it("stays pending, is visible, and is applied when the order arrives", async () => {
    const h = createHarness();
    const early = await h.sendRefund(refund({}, "30.00"));
    expect(early).toMatchObject({ status: 202, body: { status: "pending", refund: { applied_cents: 0, received_at: "2026-03-10T12:00:00.000Z" } } });

    const waiting = (await h.get("/orders/1001")).body;
    expect(waiting).toMatchObject({ status: "awaiting_order", order: null, attribution: null, ledger: [] });
    expect(waiting.pending_refunds).toHaveLength(1);

    h.time.set("2026-03-13T08:00:00.000Z");
    const arrival = await h.sendOrder(ana);
    expect(arrival.body.applied_pending_refunds).toMatchObject([{ refund_id: "5001", status: "applied", applied_cents: 3000 }]);

    const view = (await h.get("/orders/1001")).body;
    expect(view.status).toBe("known");
    expect(view.pending_refunds).toEqual([]);
    expect(view.ledger.map((e: any) => [e.kind, e.amount_cents])).toEqual([["sale", 10000], ["refund", -3000]]);
    expect(view.refunds[0]).toMatchObject({ received_at: "2026-03-10T12:00:00.000Z", resolved_at: "2026-03-13T08:00:00.000Z" });
    expect(view.ledger[1]).toMatchObject({ occurred_at: "2026-03-12T12:00:00.000Z", recorded_at: "2026-03-13T08:00:00.000Z" });
    expect((await sales(h)).totals[0]).toMatchObject({ gross_cents: 10000, refunded_cents: 3000, net_cents: 7000 });
  });

  it("the same early refund arriving twice is stored and applied once", async () => {
    const h = createHarness();
    await h.sendRefund(refund(), "r-1");
    expect((await h.sendRefund(refund(), "r-1")).body.status).toBe("duplicate_delivery");
    expect(await h.sendRefund(refund(), "r-2")).toMatchObject({ status: 200, body: { status: "duplicate_refund", refund: { status: "pending" } } });

    await h.sendOrder(ana);
    const view = (await h.get("/orders/1001")).body;
    expect(view.refunds).toHaveLength(1);
    expect(view.totals).toMatchObject({ refunded_cents: 3000, net_cents: 7000 });
  });

  it("pending refunds are applied by created_at, not by arrival, and respect the cap", async () => {
    const h = createHarness();
    await h.sendRefund(refund({ id: "late", created_at: "2026-03-15T00:00:00Z" }, "80.00"));
    await h.sendRefund(refund({ id: "early", created_at: "2026-03-11T00:00:00Z" }, "60.00"));
    await h.sendOrder(ana);

    const view = (await h.get("/orders/1001")).body;
    const byId = Object.fromEntries(view.refunds.map((r: any) => [r.refund_id, r]));
    expect(byId.early).toMatchObject({ status: "applied", applied_cents: 6000 });
    expect(byId.late).toMatchObject({ status: "capped", applied_cents: 4000, excess_cents: 4000 });
    expect(view.totals).toMatchObject({ refunded_cents: 10000, net_cents: 0 });
  });

  it("pending refund plus an order that arrives cancelled: refund first, reversal takes the rest", async () => {
    const h = createHarness();
    await h.sendRefund(refund({}, "25.00"));
    await h.sendOrder(order({ landing_site: "/?utm_content=ana", cancelled_at: "2026-03-10T11:00:00Z" }));
    expect((await h.get("/orders/1001")).body.totals).toEqual({ gross_cents: 10000, refunded_cents: 2500, reversed_cents: 7500, net_cents: 0 });
  });

  it("an early refund for another order is not applied", async () => {
    const h = createHarness();
    await h.sendRefund(refund({ order_id: 2002 }));
    await h.sendOrder(ana);
    expect((await h.get("/orders/1001")).body.totals.net_cents).toBe(10000);
    expect((await h.get("/orders/2002")).body.pending_refunds).toHaveLength(1);
  });
});

describe("creator totals after everything", () => {
  it("adds up sales, partial, repeated, capped and early refunds", async () => {
    const h = createHarness();
    await h.sendOrder(order({ id: 1, discount_codes: [{ code: "ANA10" }], total_price: "100.00" }));
    await h.sendOrder(order({ id: 2, landing_site: "/?utm_content=ana", total_price: "50.00" }));
    await h.sendOrder(order({ id: 3, landing_site: "/?utm_content=bia", total_price: "80.00" }));
    await h.sendOrder(order({ id: 4, total_price: "999.00" }));
    await h.sendOrder(order({ id: 1, discount_codes: [{ code: "ANA10" }], total_price: "100.00" }));

    await h.sendRefund(refund({ id: "r1", order_id: 1 }, "30.00"));
    await h.sendRefund(refund({ id: "r1", order_id: 1 }, "30.00"));
    await h.sendRefund(refund({ id: "r2", order_id: 2 }, "70.00"));
    await h.sendRefund(refund({ id: "r3", order_id: 5 }, "10.00"));
    await h.sendOrder(order({ id: 5, discount_codes: [{ code: "ANA10" }], total_price: "20.00" }));

    expect(await sales(h)).toMatchObject({
      creator_id: "cr_ana",
      totals: [{ currency: "BRL", orders: 3, gross_cents: 17000, refunded_cents: 9000, reversed_cents: 0, net_cents: 8000 }],
    });
    expect((await sales(h)).orders.map((o: any) => [o.order_id, o.net_cents])).toEqual([["1", 7000], ["2", 0], ["5", 1000]]);
    expect((await sales(h, "cr_bia")).totals[0]).toMatchObject({ orders: 1, net_cents: 8000 });
  });

  it("never mixes currencies", async () => {
    const h = createHarness();
    await h.sendOrder(order({ id: 1, landing_site: "/?utm_content=ana", total_price: "10.00", currency: "BRL" }));
    await h.sendOrder(order({ id: 2, landing_site: "/?utm_content=ana", total_price: "20.00", currency: "usd" }));
    expect((await sales(h)).totals).toMatchObject([
      { currency: "BRL", gross_cents: 1000 },
      { currency: "USD", gross_cents: 2000 },
    ]);
  });
});
