import { attributeOrder } from "./domain/attribution.ts";
import { isCancelled, planRefund, summarize, type Totals } from "./domain/ledger.ts";
import type { OrderInput, RefundInput } from "./domain/types.ts";
import type { Clock } from "./clock.ts";
import type { Db } from "./db.ts";
import { findCreator, sqliteDirectory } from "./storage/directory.ts";
import {
  findOrder,
  findRefund,
  insertLedgerEntry,
  insertOrder,
  insertPendingRefund,
  ledgerForCreator,
  ledgerForOrder,
  orderNetCents,
  pendingRefundsForOrder,
  recordDelivery,
  refundsForOrder,
  resolveRefund,
  updateOrderStatus,
  type RefundRow,
} from "./storage/orders.ts";

export type OrderResult =
  | { status: "duplicate_delivery" }
  | { status: "duplicate_order"; order_id: string; creator_id: string | null; cancelled_now: boolean }
  | { status: "created"; order_id: string; creator_id: string | null; rule: string; conflicts: number; applied_pending_refunds: RefundRow[] };

export type RefundResult =
  | { status: "duplicate_delivery" }
  | { status: "ignored"; reason: "no_refund_amount" }
  | { status: "duplicate_refund"; refund: RefundRow }
  | { status: RefundRow["status"]; refund: RefundRow };

type OrderRef = { id: string; creator_id: string | null; currency: string };

export class SalesService {
  private readonly directory;

  constructor(private readonly db: Db, private readonly clock: Clock) {
    this.directory = sqliteDirectory(db);
  }

  ingestOrder(order: OrderInput, deliveryId: string | null): OrderResult {
    return this.db.transaction(() => {
      const now = this.now();
      if (deliveryId && !recordDelivery(this.db, deliveryId, "orders", now)) return { status: "duplicate_delivery" };

      const existing = findOrder(this.db, order.id);
      if (existing) return this.updateKnownOrder(existing, order, now);

      // Frozen here: later webhooks for this order never touch the attribution.
      const attribution = attributeOrder(order.signals, this.directory);
      insertOrder(this.db, order, attribution, now);
      const ref: OrderRef = { id: order.id, creator_id: attribution.creator_id, currency: order.currency };
      insertLedgerEntry(this.db, { orderId: order.id, creatorId: ref.creator_id, kind: "sale", amountCents: order.totalCents, occurredAt: order.createdAt, recordedAt: now });

      const pending = pendingRefundsForOrder(this.db, order.id);
      for (const refund of pending) this.settleRefund(ref, refund, now);
      if (isCancelled(order)) this.reverseRemaining(ref, order.cancelledAt ?? now, now);

      return {
        status: "created",
        order_id: order.id,
        creator_id: attribution.creator_id,
        rule: attribution.rule,
        conflicts: attribution.conflicts.length,
        applied_pending_refunds: pending.map((refund) => findRefund(this.db, refund.refund_id)!),
      };
    });
  }

  ingestRefund(refund: RefundInput, deliveryId: string | null): RefundResult {
    // Restock-only refunds carry no refund transaction; there is no money to trace.
    if (refund.amountCents === 0) return { status: "ignored", reason: "no_refund_amount" };
    return this.db.transaction(() => {
      const now = this.now();
      if (deliveryId && !recordDelivery(this.db, deliveryId, "refunds", now)) return { status: "duplicate_delivery" };

      const known = findRefund(this.db, refund.id);
      if (known) return { status: "duplicate_refund", refund: known };

      insertPendingRefund(this.db, refund, now);
      const order = findOrder(this.db, refund.orderId);
      if (order) this.settleRefund(order, findRefund(this.db, refund.id)!, now);

      const stored = findRefund(this.db, refund.id)!;
      return { status: stored.status, refund: stored };
    });
  }

  getOrder(orderId: string) {
    const order = findOrder(this.db, orderId);
    const refunds = refundsForOrder(this.db, orderId);
    if (!order && refunds.length === 0) return null;

    const ledger = ledgerForOrder(this.db, orderId);
    const base = {
      totals: summarize(ledger),
      ledger,
      refunds,
      pending_refunds: refunds.filter((refund) => refund.status === "pending"),
    };
    if (!order) return { id: orderId, status: "awaiting_order" as const, order: null, attribution: null, ...base };

    return {
      id: orderId,
      status: "known" as const,
      order: {
        name: order.name,
        currency: order.currency,
        total_cents: order.total_cents,
        financial_status: order.financial_status,
        cancelled_at: order.cancelled_at,
        created_at: order.created_at,
        received_at: order.received_at,
      },
      attribution: {
        creator_id: order.creator_id,
        rule: order.rule,
        evidence: JSON.parse(order.evidence) as unknown,
        conflicts: JSON.parse(order.conflicts) as unknown,
      },
      ...base,
    };
  }

  getCreatorSales(creatorId: string) {
    const creator = findCreator(this.db, creatorId);
    if (!creator) return null;

    const perOrder = new Map<string, { name: string | null; currency: string; entries: ReturnType<typeof ledgerForCreator> }>();
    for (const row of ledgerForCreator(this.db, creatorId)) {
      const group = perOrder.get(row.order_id) ?? { name: row.order_name, currency: row.currency, entries: [] };
      group.entries.push(row);
      perOrder.set(row.order_id, group);
    }

    // Different currencies are never added together.
    const perCurrency = new Map<string, { orders: number; entries: ReturnType<typeof ledgerForCreator> }>();
    const orders = [];
    for (const [orderId, group] of perOrder) {
      orders.push({ order_id: orderId, name: group.name, currency: group.currency, ...summarize(group.entries) });
      const bucket = perCurrency.get(group.currency) ?? { orders: 0, entries: [] };
      bucket.orders += 1;
      bucket.entries.push(...group.entries);
      perCurrency.set(group.currency, bucket);
    }
    const totals: Array<{ currency: string; orders: number } & Totals> = [...perCurrency]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, bucket]) => ({ currency, orders: bucket.orders, ...summarize(bucket.entries) }));

    return { creator_id: creator.id, name: creator.name, totals, orders };
  }

  // Same business key, new delivery. Nothing is re-added or re-attributed. The financial status
  // follows the webhook until the order is cancelled; the first cancellation reverses what is left.
  private updateKnownOrder(existing: NonNullable<ReturnType<typeof findOrder>>, order: OrderInput, now: string): OrderResult {
    let cancelledNow = false;
    const alreadyCancelled = isCancelled({ cancelledAt: existing.cancelled_at, financialStatus: existing.financial_status });
    if (!alreadyCancelled) {
      updateOrderStatus(this.db, existing.id, order.financialStatus ?? existing.financial_status, order.cancelledAt ?? existing.cancelled_at);
      if (isCancelled(order)) {
        this.reverseRemaining(existing, order.cancelledAt ?? now, now);
        cancelledNow = true;
      }
    }
    return { status: "duplicate_order", order_id: existing.id, creator_id: existing.creator_id, cancelled_now: cancelledNow };
  }

  private settleRefund(order: OrderRef, refund: RefundRow, now: string): void {
    const mismatch = refund.currency !== null && refund.currency !== order.currency;
    const plan = mismatch
      ? { status: "rejected" as const, appliedCents: 0, excessCents: refund.requested_cents, reason: "currency_mismatch" }
      : planRefund(orderNetCents(this.db, order.id), refund.requested_cents);

    if (plan.appliedCents > 0) {
      insertLedgerEntry(this.db, {
        orderId: order.id,
        creatorId: order.creator_id,
        kind: "refund",
        amountCents: -plan.appliedCents,
        refundId: refund.refund_id,
        occurredAt: refund.created_at,
        recordedAt: now,
      });
    }
    resolveRefund(this.db, refund.refund_id, {
      status: plan.status,
      appliedCents: plan.appliedCents,
      excessCents: plan.excessCents,
      reason: plan.reason,
      resolvedAt: now,
    });
  }

  private reverseRemaining(order: OrderRef, occurredAt: string, now: string): void {
    const remaining = orderNetCents(this.db, order.id);
    if (remaining <= 0) return;
    insertLedgerEntry(this.db, { orderId: order.id, creatorId: order.creator_id, kind: "reversal", amountCents: -remaining, occurredAt, recordedAt: now });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}
