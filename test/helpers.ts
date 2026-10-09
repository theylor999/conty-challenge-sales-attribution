import type { Clock } from "../src/clock.ts";
import type { CreatorDirectory } from "../src/domain/attribution.ts";
import { Db } from "../src/db.ts";
import { createApp } from "../src/http/app.ts";
import { signShopifyBody } from "../src/http/hmac.ts";
import { SEED_CREATORS } from "../src/seed.ts";
import { SalesService } from "../src/service.ts";
import { seedCreators } from "../src/storage/directory.ts";

export function memoryDirectory(coupons: Record<string, string>, handles: Record<string, string>): CreatorDirectory {
  return {
    byCoupon: (code) => coupons[code] ?? null,
    byHandle: (handle) => handles[handle] ?? null,
  };
}

export function fakeClock(start = "2026-03-10T12:00:00.000Z") {
  let current = new Date(start);
  const clock: Clock = { now: () => current };
  return { clock, set: (iso: string) => void (current = new Date(iso)) };
}

let deliverySeq = 0;
export const freshDeliveryId = () => `delivery-${++deliverySeq}`;

export function createHarness(options: { webhookSecret?: string } = {}) {
  const db = new Db(":memory:");
  seedCreators(db, SEED_CREATORS);
  const time = fakeClock();
  const service = new SalesService(db, time.clock);
  const app = createApp({ service, webhookSecret: options.webhookSecret });

  async function send(path: string, body: unknown, headers: Record<string, string> = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const res = await app.request(path, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } });
    return { status: res.status, body: (await res.json()) as any };
  }
  async function get(path: string) {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  }

  return {
    db,
    app,
    service,
    time,
    get,
    sendOrder: (order: unknown, deliveryId: string | null = freshDeliveryId()) =>
      send("/webhooks/orders", order, deliveryId ? { "x-shopify-webhook-id": deliveryId } : {}),
    sendRefund: (refund: unknown, deliveryId: string | null = freshDeliveryId()) =>
      send("/webhooks/refunds", refund, deliveryId ? { "x-shopify-webhook-id": deliveryId } : {}),
    send,
    sign: (raw: string) => signShopifyBody(options.webhookSecret ?? "", raw),
  };
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    name: "#1001",
    total_price: "100.00",
    currency: "BRL",
    financial_status: "paid",
    discount_codes: [],
    landing_site: "/",
    created_at: "2026-03-10T10:00:00-03:00",
    ...overrides,
  };
}

export function refund(overrides: Record<string, unknown> = {}, amount = "30.00") {
  return {
    id: 5001,
    order_id: 1001,
    created_at: "2026-03-12T09:00:00-03:00",
    transactions: [{ amount, kind: "refund", status: "success", currency: "BRL" }],
    ...overrides,
  };
}
