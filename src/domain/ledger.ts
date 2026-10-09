export type EntryKind = "sale" | "refund" | "reversal";

export interface LedgerEntry {
  kind: EntryKind;
  /** Signed: sale is positive, refund and reversal are negative. */
  amount_cents: number;
}

export interface Totals {
  gross_cents: number;
  refunded_cents: number;
  reversed_cents: number;
  net_cents: number;
}

export type RefundOutcome = "applied" | "capped" | "rejected";

export interface RefundPlan {
  status: RefundOutcome;
  appliedCents: number;
  excessCents: number;
}

/**
 * A refund never takes the order below zero: it is applied up to what is left
 * and the excess is kept on the refund record instead of being dropped.
 */
export function planRefund(remainingCents: number, requestedCents: number): RefundPlan {
  const appliedCents = Math.min(requestedCents, Math.max(remainingCents, 0));
  const excessCents = requestedCents - appliedCents;
  const status: RefundOutcome = excessCents === 0 ? "applied" : appliedCents === 0 ? "rejected" : "capped";
  return { status, appliedCents, excessCents };
}

export function summarize(entries: Iterable<LedgerEntry>): Totals {
  const totals: Totals = { gross_cents: 0, refunded_cents: 0, reversed_cents: 0, net_cents: 0 };
  for (const entry of entries) {
    totals.net_cents += entry.amount_cents;
    if (entry.kind === "sale") totals.gross_cents += entry.amount_cents;
    else if (entry.kind === "refund") totals.refunded_cents -= entry.amount_cents;
    else totals.reversed_cents -= entry.amount_cents;
  }
  return totals;
}

export interface CancellationSignals {
  cancelledAt: string | null;
  financialStatus: string | null;
}

/** `refunded` is deliberately not here: refund amounts come from refund webhooks only. */
export function isCancelled(order: CancellationSignals): boolean {
  return order.cancelledAt !== null || order.financialStatus === "voided";
}
