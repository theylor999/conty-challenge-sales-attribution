import { createHmac, timingSafeEqual } from "node:crypto";

/** Shopify signs the raw body with HMAC-SHA256 and sends it base64-encoded. */
export function verifyShopifyHmac(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const received = Buffer.from(header, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signShopifyBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}
