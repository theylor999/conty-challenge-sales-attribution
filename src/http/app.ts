import { Hono, type Context } from "hono";
import type { SalesService } from "../service.ts";
import { verifyShopifyHmac } from "./hmac.ts";
import { PayloadError, parseJsonBody, parseOrderPayload, parseRefundPayload } from "./payloads.ts";

export interface AppOptions {
  service: SalesService;
  /** When set, every webhook must carry a valid X-Shopify-Hmac-Sha256. */
  webhookSecret?: string;
}

type Success = 200 | 201 | 202;

export function createApp({ service, webhookSecret }: AppOptions): Hono {
  const app = new Hono();

  async function readWebhook(c: Context): Promise<{ body: unknown; deliveryId: string | null } | Response> {
    const raw = await c.req.text();
    if (webhookSecret && !verifyShopifyHmac(webhookSecret, raw, c.req.header("x-shopify-hmac-sha256"))) {
      return c.json({ error: "invalid_signature" }, 401);
    }
    try {
      return { body: parseJsonBody(raw), deliveryId: c.req.header("x-shopify-webhook-id")?.trim() || null };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
  }

  app.post("/webhooks/orders", async (c) => {
    const webhook = await readWebhook(c);
    if (webhook instanceof Response) return webhook;
    try {
      const result = service.ingestOrder(parseOrderPayload(webhook.body), webhook.deliveryId);
      return c.json(result, result.status === "created" ? 201 : 200);
    } catch (error) {
      return payloadProblem(c, error);
    }
  });

  app.post("/webhooks/refunds", async (c) => {
    const webhook = await readWebhook(c);
    if (webhook instanceof Response) return webhook;
    try {
      const result = service.ingestRefund(parseRefundPayload(webhook.body), webhook.deliveryId);
      return c.json(result, refundStatusCode(result.status));
    } catch (error) {
      return payloadProblem(c, error);
    }
  });

  app.get("/orders/:id", (c) => {
    const view = service.getOrder(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "not_found" }, 404);
  });

  app.get("/creators/:id/sales", (c) => {
    const sales = service.getCreatorSales(c.req.param("id"));
    return sales ? c.json(sales) : c.json({ error: "not_found" }, 404);
  });

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

function refundStatusCode(status: string): Success {
  if (status === "pending") return 202;
  if (status === "applied" || status === "capped" || status === "rejected") return 201;
  return 200;
}

function payloadProblem(c: Context, error: unknown): Response {
  if (error instanceof PayloadError) return c.json({ error: "invalid_payload", message: error.message }, 422);
  throw error;
}
