// Fee math for the marketplace. All money in integer cents.
// - Delivery: K25 base + K10/km (matches the Flutter app's CartProvider).
// - VAT: 16% on goods subtotal (ZRA).
// - Buyer payment fee: platform cut + Lipila processor fee, added on top of
//   the order total and charged to the buyer (COA model).
//   Mobile money: max(base x (1% + 2.5%), K3). Card: max(base x (2% + 2.5%), K5).
// - The tenant keeps 100% of the goods subtotal (seller commission retired).
// - Payout fee: Lipila disbursement 1.5% + platform 1% (min K3), deducted at
//   settlement. The rider keeps the delivery fee.

export interface FeeSettings {
  vatPct: number;
  /** Platform cut % on mobile-money payments, buyer-borne (app_settings: platform_commission_pct). */
  commissionPct: number;
  /** Minimum buyer fee on mobile money, in cents (app_settings: platform_min_fee_cents). */
  platformMinFeeCents: number;
  /** Platform cut % on card payments, buyer-borne (app_settings: platform_card_fee_pct). */
  cardPlatformPct: number;
  /** Minimum buyer fee on card, in cents (app_settings: platform_card_min_fee_cents). */
  cardPlatformMinFeeCents: number;
  /** Platform cut % deducted from payouts (app_settings: platform_payout_fee_pct). */
  payoutPlatformPct: number;
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
    commissionPct: num("PLATFORM_COMMISSION_PCT", 1),
    platformMinFeeCents: Math.round(num("PLATFORM_MIN_FEE_CENTS", 300)),
    cardPlatformPct: num("PLATFORM_CARD_FEE_PCT", 2),
    cardPlatformMinFeeCents: Math.round(num("PLATFORM_CARD_MIN_FEE_CENTS", 500)),
    payoutPlatformPct: num("PLATFORM_PAYOUT_FEE_PCT", 1),
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
  platform_min_fee_cents: "PLATFORM_MIN_FEE_CENTS",
  platform_card_fee_pct: "PLATFORM_CARD_FEE_PCT",
  platform_card_min_fee_cents: "PLATFORM_CARD_MIN_FEE_CENTS",
  platform_payout_fee_pct: "PLATFORM_PAYOUT_FEE_PCT",
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

/** Full fee added to the buyer's payment: platform cut + Lipila processor fee, floored at a minimum (MoMo K3, card K5). */
export function buyerPaymentFeeCents(
  feeSettings: Pick<FeeSettings, "commissionPct" | "cardPlatformPct" | "platformMinFeeCents" | "cardPlatformMinFeeCents" | "lipilaCollectionFeePct" | "cardLipilaCollectionFeePct">,
  baseCents: number,
  paymentMethod: "mobile_money" | "card"
): number {
  const isCard = paymentMethod === "card";
  const platformPct = isCard ? feeSettings.cardPlatformPct : feeSettings.commissionPct;
  const processorPct = isCard ? feeSettings.cardLipilaCollectionFeePct : feeSettings.lipilaCollectionFeePct;
  const minCents = isCard ? feeSettings.cardPlatformMinFeeCents : feeSettings.platformMinFeeCents;
  return Math.max(Math.round(baseCents * ((platformPct + processorPct) / 100)), minCents);
}

/** Lipila's processor portion of the buyer fee. */
export function processorFeeCents(
  feeSettings: Pick<FeeSettings, "lipilaCollectionFeePct" | "cardLipilaCollectionFeePct">,
  baseCents: number,
  paymentMethod: "mobile_money" | "card"
): number {
  const pct = paymentMethod === "card" ? feeSettings.cardLipilaCollectionFeePct : feeSettings.lipilaCollectionFeePct;
  return Math.round(baseCents * (pct / 100));
}

/** Platform's revenue inside one buyer payment: everything Lipila does not take. */
export function platformFeeOfPaymentCents(
  feeSettings: Pick<FeeSettings, "commissionPct" | "cardPlatformPct" | "platformMinFeeCents" | "cardPlatformMinFeeCents" | "lipilaCollectionFeePct" | "cardLipilaCollectionFeePct">,
  baseCents: number,
  paymentMethod: "mobile_money" | "card"
): number {
  return Math.max(0, buyerPaymentFeeCents(feeSettings, baseCents, paymentMethod) - processorFeeCents(feeSettings, baseCents, paymentMethod));
}

/** Platform's cut on a payout: 1% (min K3), same floor as the buyer mobile-money fee. */
export function payoutPlatformFeeCents(
  feeSettings: Pick<FeeSettings, "payoutPlatformPct" | "platformMinFeeCents">,
  amountCents: number
): number {
  return Math.max(Math.round(amountCents * (feeSettings.payoutPlatformPct / 100)), feeSettings.platformMinFeeCents);
}

export interface OrderTotals {
  subtotalCents: number;
  vatCents: number;
  deliveryFeeCents: number;
  paymentFeeCents: number;   // buyer-paid fee on top of the order (platform cut + Lipila processor fee)
  lipilaFeeCents: number;    // Lipila's processor portion of paymentFeeCents
  platformFeeCents: number;  // platform's portion of paymentFeeCents (stored on orders.platform_fee_cents)
  totalCents: number;
  commissionCents: number;   // retired: seller commission, always 0
  businessShareCents: number; // goods subtotal credited to the business wallet
}

export function computeOrderTotals(
  feeSettings: FeeSettings,
  params: {
    items: { priceCents: number; quantity: number }[];
    deliveryKm: number;
    paymentMethod: "mobile_money" | "card";
  }
): OrderTotals {
  const subtotalCents = params.items.reduce((sum, it) => sum + it.priceCents * it.quantity, 0);
  const vatCents = Math.round(subtotalCents * (feeSettings.vatPct / 100));
  const delivery = deliveryFeeCents(feeSettings, params.deliveryKm);
  const baseCents = subtotalCents + vatCents + delivery;
  const paymentFeeCents = buyerPaymentFeeCents(feeSettings, baseCents, params.paymentMethod);
  const lipilaFeeCents = processorFeeCents(feeSettings, baseCents, params.paymentMethod);
  const platformFeeCents = Math.max(0, paymentFeeCents - lipilaFeeCents);
  const totalCents = baseCents + paymentFeeCents;
  return {
    subtotalCents,
    vatCents,
    deliveryFeeCents: delivery,
    paymentFeeCents,
    lipilaFeeCents,
    platformFeeCents,
    totalCents,
    commissionCents: 0,
    businessShareCents: subtotalCents,
  };
}

/** Disbursement net = amount - Lipila disbursement fee - platform payout cut (1%, min K3). */
export function payoutNetCents(
  feeSettings: Pick<FeeSettings, "lipilaDisbursementFeePct" | "payoutPlatformPct" | "platformMinFeeCents">,
  amountCents: number
): number {
  const lipila = Math.round(amountCents * (feeSettings.lipilaDisbursementFeePct / 100));
  return Math.max(0, amountCents - lipila - payoutPlatformFeeCents(feeSettings, amountCents));
}
