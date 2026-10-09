import { InvalidMoneyError, parseMoney } from "../domain/money.ts";
import type { OrderInput, RefundInput } from "../domain/types.ts";

export class PayloadError extends Error {}

type Obj = Record<string, unknown>;

// Shopify ids can exceed 2^53 and JSON.parse would round them; quote them first.
const LONG_ID = /("(?:id|order_id)"\s*:\s*)(\d{16,})/g;

export function parseJsonBody(raw: string): unknown {
  return JSON.parse(raw.replace(LONG_ID, '$1"$2"'));
}

export function parseOrderPayload(body: unknown): OrderInput {
  const o = asObject(body, "body");
  const cancelledAt = o.cancelled_at == null ? null : asIso(o.cancelled_at, "cancelled_at");
  return {
    id: asId(o.id, "id"),
    name: typeof o.name === "string" ? o.name : null,
    totalCents: asMoney(o.total_price, "total_price"),
    currency: asCurrency(o.currency, "currency"),
    financialStatus: typeof o.financial_status === "string" ? o.financial_status : null,
    cancelledAt,
    createdAt: asIso(o.created_at, "created_at"),
    signals: {
      discount_codes: Array.isArray(o.discount_codes) ? o.discount_codes : null,
      landing_site: typeof o.landing_site === "string" ? o.landing_site : null,
      note_attributes: Array.isArray(o.note_attributes) ? o.note_attributes : null,
    },
  };
}

export function parseRefundPayload(body: unknown): RefundInput {
  const r = asObject(body, "body");
  if (!Array.isArray(r.transactions)) throw new PayloadError("transactions must be an array");

  let amountCents = 0;
  const currencies = new Set<string>();
  for (const raw of r.transactions) {
    const tx = asObject(raw, "transactions[]");
    if (tx.kind !== "refund") continue;
    if (tx.status !== undefined && tx.status !== "success") continue;
    amountCents += asMoney(tx.amount, "transactions[].amount");
    if (!Number.isSafeInteger(amountCents)) throw new PayloadError("refund amount is too large");
    if (tx.currency != null) currencies.add(asCurrency(tx.currency, "transactions[].currency"));
  }
  if (currencies.size > 1) throw new PayloadError("refund mixes currencies");

  return {
    id: asId(r.id, "id"),
    orderId: asId(r.order_id, "order_id"),
    amountCents,
    currency: [...currencies][0] ?? null,
    createdAt: asIso(r.created_at, "created_at"),
  };
}

function asObject(value: unknown, field: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PayloadError(`${field} must be an object`);
  return value as Obj;
}

// "1001" and 1001 are the same order.
function asId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  throw new PayloadError(`${field} must be a positive integer or a short id string`);
}

function asMoney(value: unknown, field: string): number {
  if (typeof value !== "string") throw new PayloadError(`${field} must be a decimal string such as "199.90"`);
  try {
    return parseMoney(value);
  } catch (error) {
    if (error instanceof InvalidMoneyError) throw new PayloadError(`${field} must be a decimal string with at most 2 decimals`);
    throw error;
  }
}

function asCurrency(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) throw new PayloadError(`${field} must be a 3-letter currency code`);
  return value.toUpperCase();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Date alone accepts "1" or "2026-02-30" (rolled to March), so the shape and calendar are checked first.
function asIso(value: unknown, field: string): string {
  const match = typeof value === "string" ? ISO.exec(value) : null;
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = new Date(value as string);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  throw new PayloadError(`${field} must be an ISO 8601 timestamp with a timezone offset`);
}
