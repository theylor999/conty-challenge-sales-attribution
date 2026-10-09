import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.ts";
import { seedCreators } from "../src/storage/directory.ts";
import { SEED_CREATORS } from "../src/seed.ts";
import { insertLedgerEntry } from "../src/storage/orders.ts";

// The service already avoids these states; here the database is attacked directly.
describe("database guarantees", () => {
  let db: Db;
  const entry = (kind: "sale" | "refund" | "reversal", amountCents: number, refundId?: string) =>
    insertLedgerEntry(db, { orderId: "o1", creatorId: null, kind, amountCents, refundId, occurredAt: "t", recordedAt: "t" });

  beforeEach(() => {
    db = new Db(":memory:");
    seedCreators(db, SEED_CREATORS);
    db.run(
      `INSERT INTO orders (id, currency, total_cents, created_at, received_at, rule, evidence, conflicts) VALUES ('o1', 'BRL', 10000, 't', 't', 'none', '{}', '[]')`,
    );
    for (const id of ["r1", "r2"]) {
      db.run(`INSERT INTO refunds (refund_id, order_id, requested_cents, status, created_at, received_at) VALUES (?, 'o1', 100, 'pending', 't', 't')`, id);
    }
    entry("sale", 10000);
  });

  it("refuses a second sale for the same order", () => {
    expect(() => entry("sale", 10000)).toThrow(/UNIQUE/);
  });

  it("refuses two ledger entries for the same refund id", () => {
    entry("refund", -1000, "r1");
    expect(() => entry("refund", -1000, "r1")).toThrow(/UNIQUE/);
  });

  it("refuses a refund that takes the net below zero", () => {
    entry("refund", -9000, "r1");
    expect(() => entry("refund", -1001, "r2")).toThrow(/below zero/);
    expect(() => entry("refund", -1000, "r2")).not.toThrow();
  });

  it("refuses a second reversal", () => {
    entry("reversal", -4000);
    expect(() => entry("reversal", -1000)).toThrow(/UNIQUE/);
  });

  it("is append-only", () => {
    expect(() => db.run("UPDATE ledger_entries SET amount_cents = 1")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM ledger_entries")).toThrow(/append-only/);
  });

  it("is append-only against INSERT OR REPLACE too", () => {
    entry("refund", -9000, "r1");
    expect(() => db.run("INSERT OR REPLACE INTO ledger_entries (order_id, kind, amount_cents, occurred_at, recorded_at) VALUES ('o1', 'sale', 100, 't', 't')")).toThrow(/append-only/);
    expect(db.get<{ total: number }>("SELECT SUM(amount_cents) AS total FROM ledger_entries")!.total).toBe(1000);
  });

  it("rolls the whole transaction back on error", () => {
    expect(() =>
      db.transaction(() => {
        entry("refund", -1000, "r1");
        entry("refund", -99999, "r2");
      }),
    ).toThrow();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ledger_entries")!.n).toBe(1);
  });
});
