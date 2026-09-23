// ZRA SmartInvoice-ready invoice generation.
// Zambia requires e-invoicing (SmartInvoice): every business with a TPIN must
// issue e-invoices via ZRA within 24h of supply. This module generates local
// invoice records + a ZRA QR payload. When the ZRA production API is enabled
// (app_settings.zra_enabled), syncInvoiceToZra pushes them; until then invoices
// are fully functional locally (PDF/SMS) and ready to sync.

export interface InvoiceLine {
  name: string;
  priceCents: number;
  quantity: number;
  vatPct: number;
}

export interface InvoiceData {
  invoiceNo: string;
  orderId: string;
  businessId: number;
  businessName: string;
  tpin: string; // business TPIN
  customerId: number;
  customerName: string;
  customerPhone: string;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  lines: InvoiceLine[];
  issuedAt: string; // ISO 8601
}

/** Generates the next invoice number: SOA-<year>-<6-digit sequential>. */
export async function nextInvoiceNo(db: D1Database): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SOA-${year}-`;
  const row = await db
    .prepare("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1")
    .bind(`${prefix}%`)
    .first<{ invoice_no: string }>();
  const lastSeq = row ? Number(row.invoice_no.slice(prefix.length)) || 0 : 0;
  return `${prefix}${String(lastSeq + 1).padStart(6, "0")}`;
}

/**
 * ZRA SmartInvoice QR payload (spec-compliant JSON). ZRA's smartphone app
 * verifies the AFC code + invoice details by scanning this QR.
 * NOTE: verify field names/order against the current ZRA SmartInvoice
 * integration docs before production enablement.
 */
export function zraQrPayload(inv: InvoiceData): string {
  const payload = {
    format: "ZRA-01",
    tpin: inv.tpin,
    invoiceNo: inv.invoiceNo,
    date: inv.issuedAt,
    total: (inv.totalCents / 100).toFixed(2),
    vat: (inv.vatCents / 100).toFixed(2),
    afcCode: "", // filled by ZRA on sync
  };
  return JSON.stringify(payload);
}

/**
 * Push an invoice to ZRA SmartInvoice. Until the ZRA sandbox API credentials
 * are provisioned (app_settings.zra_enabled='0'), this logs and returns null.
 * When enabled: POST the e-invoice payload, store returned AFC/ACF codes,
 * mark status='synced'.
 */
export async function syncInvoiceToZra(
  db: D1Database,
  env: { ZRA_API_KEY?: string },
  invoiceId: number
): Promise<{ synced: boolean; afc?: string; acf?: string; error?: string }> {
  const setting = await db.prepare("SELECT value FROM app_settings WHERE key = 'zra_enabled'").first<{ value: string }>();
  const apiUrl = await db.prepare("SELECT value FROM app_settings WHERE key = 'zra_api_url'").first<{ value: string }>();
  const enabled = setting?.value === "1";

  if (!enabled || !env.ZRA_API_KEY || !apiUrl?.value) {
    console.log(`[ZRA] invoice ${invoiceId} not synced (zra_enabled=${enabled})`);
    return { synced: false };
  }

  const inv = await db
    .prepare(
      `SELECT i.*, b.name AS business_name, b.tpin, u.name AS customer_name, u.phone AS customer_phone
       FROM invoices i
       JOIN businesses b ON b.id = i.business_id
       JOIN users u ON u.id = i.customer_id
       WHERE i.id = ?`
    )
    .bind(invoiceId)
    .first<any>();
  if (!inv) return { synced: false, error: "invoice not found" };

  const res = await fetch(`${apiUrl.value}/invoice`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.ZRA_API_KEY}`,
    },
    body: JSON.stringify({
      tpin: inv.tpin,
      invoiceNo: inv.invoice_no,
      issuedAt: inv.issued_at,
      total: inv.total_cents / 100,
      vat: inv.vat_cents / 100,
      lines: JSON.parse(
        JSON.stringify(
          await db
            .prepare("SELECT name, price_cents, quantity, vat_pct FROM invoice_items WHERE invoice_id = ?")
            .bind(invoiceId)
            .all()
        )
      ).results ?? [],
    }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) return { synced: false, error: `ZRA sync failed (${res.status}): ${body.slice(0, 300)}` };

  let data: any = {};
  try { data = JSON.parse(body); } catch { /* keep empty */ }
  const afc = data.afcCode ?? data.afc ?? null;
  const acf = data.acfCode ?? data.acf ?? null;
  await db
    .prepare("UPDATE invoices SET afc_code = ?, acf_code = ?, zra_qr = ?, status = 'synced', synced_at = datetime('now') WHERE id = ?")
    .bind(afc, acf, zraQrPayload({
      invoiceNo: inv.invoice_no, orderId: inv.order_id, businessId: inv.business_id,
      businessName: inv.business_name, tpin: inv.tpin, customerId: inv.customer_id,
      customerName: inv.customer_name, customerPhone: inv.customer_phone,
      subtotalCents: inv.subtotal_cents, vatCents: inv.vat_cents, totalCents: inv.total_cents,
      lines: [], issuedAt: inv.issued_at,
    }), invoiceId)
    .run();
  return { synced: true, afc, acf };
}
