import type { AttributionSignals } from "./attribution.ts";

export interface OrderInput {
  id: string;
  name: string | null;
  totalCents: number;
  currency: string;
  financialStatus: string | null;
  cancelledAt: string | null;
  createdAt: string;
  signals: AttributionSignals;
}

export interface RefundInput {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string | null;
  createdAt: string;
}
