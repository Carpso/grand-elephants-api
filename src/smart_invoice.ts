// ZRA SmartInvoice submission client.
//
// The invoice lifecycle lives in ./invoice.ts (local invoice records + QR +
// syncInvoiceToZra once app_settings.zra_enabled = '1'). This module is the
// dedicated SmartInvoice submission seam: the invoice-issuance path calls
// `submitInvoice` for every newly issued invoice.
//
// Research (2026-09): ZRA Smart Invoice integrations go through the VSDC
// (Virtual Sales Data Controller) API. Sources:
//  - Official "VSDC API Specification" (v1.0.7-1), linked from zra.org.zm
//    (Smart Invoice → Integrations → VSDC API Specification).
//  - github.com/williemwewa/vsdc_api_postman_collection (built from that
//    spec): documents `POST {base}/trnsSales/saveSales` / SalesInformation
//    endpoints, device init via `POST /initializer/selectInitInfo`.
//  - github.com/CrystalisedApps/ca-erpnext-zra (official-spec based):
//    `POST /SalesInformation/SaveSales` submits a normal sales invoice;
//    auth is TPIN/device credentials, often sent as a Bearer token.
//  - github.com/Turing-Consult/zra-smart-invoice config shows the public
//    sandbox base URL: https://api-sandbox.zra.org.zm/vsdc-api/v1
//
// The PRODUCTION base URL is not publicly documented, so it is config-driven:
// ZRA_BASE_URL env > app_settings `zra_base_url` > app_settings `zra_api_url`
// (legacy) > the documented sandbox default below. Auth scheme is configurable
// (ZRA_AUTH_SCHEME, default "Bearer") with ZRA_API_KEY as the credential.

export interface SmartInvoiceLine {
  name: string;
  priceCents: number;
  quantity: number;
  vatPct?: number;
}

export interface SmartInvoiceSubmission {
  invoiceId: number;
  invoiceNo: string;
  orderId: string;
  businessId: number;
  /** Buyer ZRA TPIN (orders.buyer_tpin); empty when the buyer has none. */
  buyerTpin: string;
  /** Business ZRA TPIN (businesses.tpin / invoices.tp_in). */
  sellerTpin: string;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  issuedAt: string;
  customerName?: string;
  customerPhone?: string;
  /** Invoice/order line items, when the caller has them. */
  lines?: SmartInvoiceLine[];
}

export interface SmartInvoiceResult {
  submitted: boolean;
  skipped: boolean;
  reason?: string;
  /** ZRA Automatic Fiscal Code (returned on success, when present). */
  afcCode?: string;
  /** ZRA ACF / self-billing code (returned on success, when present). */
  acfCode?: string;
  /** QR payload returned by ZRA (when present). */
  qr?: string;
}

export interface SmartInvoiceEnv {
  ZRA_API_KEY?: string;
  /** Full base URL of the ZRA/VSDC gateway (see module header). */
  ZRA_BASE_URL?: string;
  /** Authorization scheme, default "Bearer". */
  ZRA_AUTH_SCHEME?: string;
}

/** VSDC normal-sale submission path, appended to the configured base URL. */
const SUBMIT_PATH = "/SalesInformation/SaveSales";
/** Documented sandbox default (Turing-Consult/zra-smart-invoice); production must set ZRA_BASE_URL. */
const DEFAULT_ZRA_BASE_URL = "https://api-sandbox.zra.org.zm/vsdc-api/v1";
const SUBMIT_TIMEOUT_MS = 15_000;

/** Response field names for the AFC/ACF/QR values (ZRA gateways differ). */
const AFC_KEYS = ["afcCode", "afc_code", "afc", "AFC", "fiscalCode", "fiscal_code"];
const ACF_KEYS = ["acfCode", "acf_code", "acf", "ACF"];
const QR_KEYS = ["qr", "qrCode", "qr_code", "qrPayload", "qr_payload", "zraQr", "qrData"];

function pickField(data: any, keys: string[]): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  // Some gateways wrap the invoice in { data | result | response | invoice: {...} }.
  for (const nested of ["data", "result", "response", "invoice"]) {
    const inner = data[nested];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const v = pickField(inner, keys);
      if (v) return v;
    }
  }
  return undefined;
}

/** SmartInvoice payload (amounts in kwacha, strings, like the local QR payload). */
function buildPayload(invoice: SmartInvoiceSubmission) {
  return {
    invoiceId: invoice.invoiceId,
    invoiceNo: invoice.invoiceNo,
    orderId: invoice.orderId,
    businessId: invoice.businessId,
    tpin: invoice.sellerTpin,
    buyerTpin: invoice.buyerTpin || null,
    currency: "ZMW",
    issueDate: invoice.issuedAt,
    subtotal: (invoice.subtotalCents / 100).toFixed(2),
    vat: (invoice.vatCents / 100).toFixed(2),
    total: (invoice.totalCents / 100).toFixed(2),
    customerName: invoice.customerName ?? "",
    customerPhone: invoice.customerPhone ?? "",
    lines: (invoice.lines ?? []).map((l) => ({
      name: l.name,
      unitPrice: (l.priceCents / 100).toFixed(2),
      quantity: l.quantity,
      vatPct: l.vatPct ?? 0,
      lineTotal: ((l.priceCents * l.quantity) / 100).toFixed(2),
    })),
  };
}

/**
 * Push an invoice to ZRA SmartInvoice (VSDC). Never throws: failures come back
 * as `{ submitted: false, skipped: false, reason }`. Skips (no API key) keep
 * the original contract so nothing pushes until credentials are provisioned.
 */
export async function submitInvoice(
  env: SmartInvoiceEnv,
  invoice: SmartInvoiceSubmission
): Promise<SmartInvoiceResult> {
  if (!env.ZRA_API_KEY) {
    console.log(
      `[smart_invoice] skipped ${invoice.invoiceNo} (order ${invoice.orderId}): ZRA API key not configured`
    );
    return { submitted: false, skipped: true, reason: "zra_api_key_missing" };
  }

  const baseUrl = (env.ZRA_BASE_URL?.trim() || DEFAULT_ZRA_BASE_URL).replace(/\/+$/, "");
  const scheme = env.ZRA_AUTH_SCHEME?.trim() || "Bearer";
  const endpoint = `${baseUrl}${SUBMIT_PATH}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `${scheme} ${env.ZRA_API_KEY}`,
        },
        body: JSON.stringify(buildPayload(invoice)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      console.error(`[smart_invoice] ${invoice.invoiceNo} rejected (HTTP ${res.status}): ${text.slice(0, 300)}`);
      return { submitted: false, skipped: false, reason: `zra_http_${res.status}` };
    }

    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* keep empty */ }
    if (data && (data.success === false || data.error)) {
      const reason = String(data.message ?? data.error ?? "zra_error").slice(0, 200);
      console.error(`[smart_invoice] ${invoice.invoiceNo} error response: ${reason}`);
      return { submitted: false, skipped: false, reason };
    }

    const afcCode = pickField(data, AFC_KEYS);
    const acfCode = pickField(data, ACF_KEYS);
    const qr = pickField(data, QR_KEYS);
    console.log(
      `[smart_invoice] submitted ${invoice.invoiceNo} (order ${invoice.orderId})${afcCode ? ` afc=${afcCode}` : ""}`
    );
    return {
      submitted: true,
      skipped: false,
      ...(afcCode ? { afcCode } : {}),
      ...(acfCode ? { acfCode } : {}),
      ...(qr ? { qr } : {}),
    };
  } catch (e: any) {
    const reason = String(e?.name === "AbortError" ? "zra_timeout" : (e?.message ?? e)).slice(0, 200);
    console.error(`[smart_invoice] ${invoice.invoiceNo} submission failed:`, e);
    return { submitted: false, skipped: false, reason };
  }
}
