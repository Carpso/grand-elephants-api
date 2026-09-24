// ZRA SmartInvoice submission stub.
//
// The invoice lifecycle lives in ./invoice.ts (local invoice records + QR +
// syncInvoiceToZra once app_settings.zra_enabled = '1'). This module is the
// dedicated SmartInvoice submission seam: the invoice-issuance path calls
// `submitInvoice` for every newly issued invoice so the real ZRA push can be
// dropped in without touching order code again.
//
// TODO(ZRA): implement the SmartInvoice submission here (auth + POST payload,
// store returned AFC/ACF codes, mark the invoice synced).

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
}

export interface SmartInvoiceResult {
  submitted: boolean;
  skipped: boolean;
  reason?: string;
}

/** No-op until ZRA credentials are provisioned. Never throws. */
export async function submitInvoice(
  env: { ZRA_API_KEY?: string },
  invoice: SmartInvoiceSubmission
): Promise<SmartInvoiceResult> {
  if (!env.ZRA_API_KEY) {
    console.log(
      `[smart_invoice] skipped ${invoice.invoiceNo} (order ${invoice.orderId}): ZRA API key not configured`
    );
    return { submitted: false, skipped: true, reason: "zra_api_key_missing" };
  }
  // TODO(ZRA): POST the SmartInvoice payload to ZRA and store AFC/ACF codes.
  console.log(`[smart_invoice] TODO submit ${invoice.invoiceNo} (ZRA push not implemented yet)`);
  return { submitted: false, skipped: true, reason: "not_implemented" };
}
