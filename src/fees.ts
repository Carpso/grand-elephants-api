// Fee math for the marketplace. All money in integer cents.
// - Delivery: K25 base + K10/km (matches the Flutter app's CartProvider).
// - VAT: 16% on goods subtotal (ZRA).
// - Platform commission: % of goods subtotal the business pays (default 15).
// - Lipila collection fee: paid by the customer on top (added to total).
// - Lipila disbursement fee: deducted from payout at settlement.

export interface FeeSettings {
  vatPct: number;
  commissionPct: number;
  deliveryBaseFeeCents: number;
  deliveryPerKmCents: number;
  lipilaCollectionFeePct: number;
  lipilaDisbursementFeePct: number;
  cardLipilaCollectionFeePct: number;
}

export function parseSettings(raw: Record<string, string | undefined>): FeeSettings {
  const num = (k: string, d: number) => {
    const v = raw[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    vatPct: num("VAT_PCT", 16),
    commissionPct: num("PLATFORM_COMMISSION_PCT", 15),
    deliveryBaseFeeCents: Math.round(num("DELIVERY_BASE_FEE_CENTS", 2500)),
    deliveryPerKmCents: Math.round(num("DELIVERY_PER_KM_CENTS", 1000)),
    lipilaCollectionFeePct: num("LIPILA_COLLECTION_FEE_PCT", 2.5),
    lipilaDisbursementFeePct: num("LIPILA_DISBURSEMENT_FEE_PCT", 1.5),
    cardLipilaCollectionFeePct: num("CARD_LIPILA_COLLECTION_FEE_PCT", 2.5),
  };
}

/** app_settings key -> env var name (the admin Finance screen PATCHes these keys). */
const DB_FEE_KEYS: Record<string, string> = {
  vat_pct: "VAT_PCT",
  platform_commission_pct: "PLATFORM_COMMISSION_PCT",
  delivery_base_fee_cents: "DELIVERY_BASE_FEE_CENTS",
  delivery_per_km_cents: "DELIVERY_PER_KM_CENTS",
  lipila_collection_fee_pct: "LIPILA_COLLECTION_FEE_PCT",
  lipila_disbursement_fee_pct: "LIPILA_DISBURSEMENT_FEE_PCT",
  card_lipila_collection_fee_pct: "CARD_LIPILA_COLLECTION_FEE_PCT",
};

interface FeeSettingsCache {
  at: number;
  overrides: Record<string, string>;
}

const FEE_CACHE_KEY = "__geFeeSettingsCache";
const FEE_CACHE_TTL_MS = 60_000;

/** DB overrides for fee keys, cached ~60s on globalThis (per isolate). */
async function loadFeeOverrides(db: D1Database): Promise<Record<string, string>> {
  const g = globalThis as unknown as Record<string, FeeSettingsCache | undefined>;
  const cached = g[FEE_CACHE_KEY];
  if (cached && Date.now() - cached.at < FEE_CACHE_TTL_MS) return cached.overrides;
  try {
    const rows = await db.prepare("SELECT key, value FROM app_settings").all<{ key: string; value: string }>();
    const overrides: Record<string, string> = {};
    for (const r of rows.results ?? []) {
      const envKey = DB_FEE_KEYS[r.key];
      if (envKey && r.value !== undefined && r.value !== null) overrides[envKey] = String(r.value);
    }
    g[FEE_CACHE_KEY] = { at: Date.now(), overrides };
    return overrides;
  } catch {
    // D1 unavailable: keep serving the last known overrides (or env-only).
    return cached?.overrides ?? {};
  }
}

/** Drop the cached app_settings fee overrides (call after PATCH /api/admin/settings). */
export function invalidateFeeSettings(): void {
  const g = globalThis as unknown as Record<string, FeeSettingsCache | undefined>;
  const cached = g[FEE_CACHE_KEY];
  if (cached) cached.at = 0;
}

/** Fee settings from D1 `app_settings` when present, falling back to env vars. */
export async function loadFeeSettings(db: D1Database, raw: Record<string, string | undefined>): Promise<FeeSettings> {
  const overrides = await loadFeeOverrides(db);
  return parseSettings({ ...raw, ...overrides });
}

/** Delivery fee for a distance in km. K25 base + K10/km, 0 when distance is 0. */
export function deliveryFeeCents(feeSettings: Pick<FeeSettings, "deliveryBaseFeeCents" | "deliveryPerKmCents">, km: number): number {
  if (!km || km <= 0) return 0;
  return Math.round(feeSettings.deliveryBaseFeeCents + feeSettings.deliveryPerKmCents * km);
}

export interface OrderTotals {
  subtotalCents: number;
  vatCents: number;
  deliveryFeeCents: number;
  lipilaFeeCents: number;
  totalCents: number;
  commissionCents: number; // platform commission (business pays)
  businessShareCents: number; // subtotal - commission (+ delivery fee) credited to business wallet
}

export function computeOrderTotals(
  feeSettings: FeeSettings,
  params: {
    items: { priceCents: number; quantity: number }[];
    deliveryKm: number;
    paymentMethod: "mobile_money" | "card";
    businessCommissionPct?: number;
  }
): OrderTotals {
  const subtotalCents = params.items.reduce((sum, it) => sum + it.priceCents * it.quantity, 0);
  const vatCents = Math.round(subtotalCents * (feeSettings.vatPct / 100));
  const delivery = deliveryFeeCents(feeSettings, params.deliveryKm);
  const lipilaFeePct = params.paymentMethod === "card" ? feeSettings.cardLipilaCollectionFeePct : feeSettings.lipilaCollectionFeePct;
  const lipilaFeeCents = Math.round((subtotalCents + vatCents + delivery) * (lipilaFeePct / 100));
  const totalCents = subtotalCents + vatCents + delivery + lipilaFeeCents;
  const commissionPct = params.businessCommissionPct ?? feeSettings.commissionPct;
  const commissionCents = Math.round(subtotalCents * (commissionPct / 100));
  const businessShareCents = subtotalCents - commissionCents + delivery;
  return { subtotalCents, vatCents, deliveryFeeCents: delivery, lipilaFeeCents, totalCents, commissionCents, businessShareCents };
}

/** Disbursement net = amount - Lipila disbursement fee. */
export function payoutNetCents(feeSettings: Pick<FeeSettings, "lipilaDisbursementFeePct">, amountCents: number): number {
  const fee = Math.round(amountCents * (feeSettings.lipilaDisbursementFeePct / 100));
  return Math.max(0, amountCents - fee);
}
