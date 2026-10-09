import type { Attribution } from "../domain/attribution.ts";
import type { EntryKind } from "../domain/ledger.ts";
import type { OrderInput, RefundInput } from "../domain/types.ts";
import type { Db } from "../db.ts";

export interface OrderRow {
  id: string;
  name: string | null;
  currency: string;
  total_cents: number;
  financial_status: string | null;
  cancelled_at: string | null;
  created_at: string;
  received_at: string;
  creator_id: string | null;
  rule: "coupon" | "utm" | "none";
  evidence: string;
  conflicts: string;
}

export interface LedgerRow {
  id: number;
  order_id: string;
  creator_id: string | null;
  kind: EntryKind;
  amount_cents: number;
  refund_id: string | null;
  occurred_at: string;
  recorded_at: string;
}

export type RefundStatus = "pending" | "applied" | "capped" | "rejected";

export interface RefundRow {
  refund_id: string;
  order_id: string;
  currency: string | null;
  requested_cents: number;
  status: RefundStatus;
  applied_cents: number;
  excess_cents: number;
  reason: string | null;
  created_at: string;
  received_at: string;
  resolved_at: string | null;
}

/** Returns false when the delivery id was already seen. */
export function recordDelivery(db: Db, deliveryId: string, topic: string, receivedAt: string): boolean {
  return db.run("INSERT OR IGNORE INTO webhook_deliveries (topic, delivery_id, received_at) VALUES (?, ?, ?)", topic, deliveryId, receivedAt).changes === 1;
}

export const findOrder = (db: Db, id: string): OrderRow | undefined => db.get("SELECT * FROM orders WHERE id = ?", id);

export function insertOrder(db: Db, order: OrderInput, attribution: Attribution, receivedAt: string): void {
  db.run(
    `INSERT INTO orders (id, name, currency, total_cents, financial_status, cancelled_at, created_at, received_at, creator_id, rule, evidence, conflicts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    order.id, order.name, order.currency, order.totalCents, order.financialStatus, order.cancelledAt, order.createdAt, receivedAt,
    attribution.creator_id, attribution.rule, JSON.stringify(attribution.evidence), JSON.stringify(attribution.conflicts),
  );
}

export function updateOrderStatus(db: Db, id: string, financialStatus: string | null, cancelledAt: string | null): void {
  db.run("UPDATE orders SET financial_status = ?, cancelled_at = ? WHERE id = ?", financialStatus, cancelledAt, id);
}

export function insertLedgerEntry(
  db: Db,
  entry: { orderId: string; creatorId: string | null; kind: EntryKind; amountCents: number; refundId?: string; occurredAt: string; recordedAt: string },
): void {
  db.run(
    `INSERT INTO ledger_entries (order_id, creator_id, kind, amount_cents, refund_id, occurred_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entry.orderId, entry.creatorId, entry.kind, entry.amountCents, entry.refundId ?? null, entry.occurredAt, entry.recordedAt,
  );
}

export const ledgerForOrder = (db: Db, orderId: string): LedgerRow[] =>
  db.all("SELECT * FROM ledger_entries WHERE order_id = ? ORDER BY id", orderId);

export const orderNetCents = (db: Db, orderId: string): number =>
  db.get<{ net: number }>("SELECT COALESCE(SUM(amount_cents), 0) AS net FROM ledger_entries WHERE order_id = ?", orderId)!.net;

export const findRefund = (db: Db, refundId: string): RefundRow | undefined =>
  db.get("SELECT * FROM refunds WHERE refund_id = ?", refundId);

export const refundsForOrder = (db: Db, orderId: string): RefundRow[] =>
  db.all("SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at, received_at, rowid", orderId);

export const pendingRefundsForOrder = (db: Db, orderId: string): RefundRow[] =>
  db.all("SELECT * FROM refunds WHERE order_id = ? AND status = 'pending' ORDER BY created_at, received_at, rowid", orderId);

export function insertPendingRefund(db: Db, refund: RefundInput, receivedAt: string): void {
  db.run(
    `INSERT INTO refunds (refund_id, order_id, currency, requested_cents, status, created_at, received_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    refund.id, refund.orderId, refund.currency, refund.amountCents, refund.createdAt, receivedAt,
  );
}

export function resolveRefund(
  db: Db,
  refundId: string,
  resolution: { status: Exclude<RefundStatus, "pending">; appliedCents: number; excessCents: number; reason: string | null; resolvedAt: string },
): void {
  db.run(
    "UPDATE refunds SET status = ?, applied_cents = ?, excess_cents = ?, reason = ?, resolved_at = ? WHERE refund_id = ? AND status = 'pending'",
    resolution.status, resolution.appliedCents, resolution.excessCents, resolution.reason, resolution.resolvedAt, refundId,
  );
}

export interface CreatorLedgerRow extends LedgerRow {
  order_name: string | null;
  currency: string;
}

export const ledgerForCreator = (db: Db, creatorId: string): CreatorLedgerRow[] =>
  db.all(
    `SELECT l.*, o.name AS order_name, o.currency
       FROM ledger_entries l JOIN orders o ON o.id = l.order_id
      WHERE o.creator_id = ? ORDER BY o.created_at, o.id, l.id`,
    creatorId,
  );
