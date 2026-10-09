export interface CreatorDirectory {
  /** Receives a code already passed through normalizeCoupon. */
  byCoupon(code: string): string | null;
  /** Receives a handle already passed through normalizeHandle. */
  byHandle(handle: string): string | null;
}

/** The only fields attribution reads, in the shape Shopify sends them. */
export interface AttributionSignals {
  discount_codes?: ReadonlyArray<{ code?: unknown }> | null;
  landing_site?: string | null;
  note_attributes?: ReadonlyArray<{ name?: unknown; value?: unknown }> | null;
}

export type AttributionRule = "coupon" | "utm" | "none";
export type CandidateSource = "coupon" | "utm_content" | "utm_source";

export interface Candidate {
  source: CandidateSource;
  value: string;
  creator_id: string;
}

export interface Attribution {
  creator_id: string | null;
  rule: AttributionRule;
  evidence: {
    coupons: Array<{ code: string; creator_id: string | null }>;
    utm: { source: string | null; campaign: string | null; content: string | null };
    candidates: Candidate[];
  };
  /** Filled only when the signals point to more than one creator; lists every candidate. */
  conflicts: Candidate[];
}

export const normalizeCoupon = (code: string): string => code.trim().toUpperCase();
export const normalizeHandle = (handle: string): string => handle.trim().toLowerCase();

// Order of the UTM params that can carry a creator handle: content is the most specific.
const UTM_HANDLE_PARAMS = ["utm_content", "utm_source"] as const;
const UTM_KEYS = ["utm_source", "utm_campaign", "utm_content"] as const;

/**
 * The single attribution rule. Candidates are ranked by buyer intent:
 *   1. creator coupons, in the order Shopify lists them (typed at checkout)
 *   2. utm_content, then utm_source (can be stale from an older click)
 * The first candidate wins; the rest only feed `conflicts`.
 */
export function attributeOrder(order: AttributionSignals, directory: CreatorDirectory): Attribution {
  const candidates: Candidate[] = [];

  const coupons: Attribution["evidence"]["coupons"] = [];
  for (const entry of order.discount_codes ?? []) {
    if (typeof entry?.code !== "string" || entry.code.trim() === "") continue;
    const creatorId = directory.byCoupon(normalizeCoupon(entry.code));
    coupons.push({ code: entry.code, creator_id: creatorId });
    if (creatorId) candidates.push({ source: "coupon", value: entry.code, creator_id: creatorId });
  }

  const utm = readUtm(order);
  for (const param of UTM_HANDLE_PARAMS) {
    const value = utm[param];
    if (!value) continue;
    const creatorId = directory.byHandle(normalizeHandle(value));
    if (creatorId) candidates.push({ source: param, value, creator_id: creatorId });
  }

  const winner = candidates[0];
  const distinctCreators = new Set(candidates.map((c) => c.creator_id));
  return {
    creator_id: winner?.creator_id ?? null,
    rule: !winner ? "none" : winner.source === "coupon" ? "coupon" : "utm",
    evidence: {
      coupons,
      utm: { source: utm.utm_source, campaign: utm.utm_campaign, content: utm.utm_content },
      candidates,
    },
    conflicts: distinctCreators.size > 1 ? candidates : [],
  };
}

type Utm = Record<(typeof UTM_KEYS)[number], string | null>;

// landing_site wins per key; note_attributes only fills the keys it left empty.
function readUtm(order: AttributionSignals): Utm {
  const utm: Utm = { utm_source: null, utm_campaign: null, utm_content: null };
  const fromLanding = new URLSearchParams(queryOf(order.landing_site));
  for (const key of UTM_KEYS) utm[key] = clean(fromLanding.get(key));
  for (const attr of order.note_attributes ?? []) {
    if (typeof attr?.name !== "string" || typeof attr.value !== "string") continue;
    const key = attr.name.trim().toLowerCase();
    if ((UTM_KEYS as readonly string[]).includes(key) && !utm[key as keyof Utm]) {
      utm[key as keyof Utm] = clean(attr.value);
    }
  }
  return utm;
}

function queryOf(landingSite: string | null | undefined): string {
  if (!landingSite) return "";
  try {
    return new URL(landingSite, "https://shop.invalid").search;
  } catch {
    return "";
  }
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
