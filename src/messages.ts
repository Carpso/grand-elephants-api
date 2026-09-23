// Marketplace SMS templates. All amounts formatted as whole kwacha (e.g. K1,000).

export function kwacha(cents: number): string {
  const k = cents / 100;
  const [whole, frac] = k.toFixed(2).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  return frac === "00" ? `K${grouped}` : `K${grouped}.${frac}`;
}

export function otpSms(code: string, ttlMinutes: number): string {
  return `SELLONAPP: Your Sell On App verification code is ${code}. It expires in ${ttlMinutes} minutes. Do not share it.`;
}

export function orderConfirmedSms(orderId: string, totalCents: number, businessName: string): string {
  return `SELLONAPP: Order ${orderId} of ${kwacha(totalCents)} confirmed at ${businessName}. Track it in the app.`;
}

export function orderStatusSms(orderId: string, status: string, businessName: string): string {
  return `SELLONAPP: Order ${orderId} is now ${status} at ${businessName}. Track it in the app.`;
}

export function orderDeliveredSms(orderId: string, businessName: string): string {
  return `SELLONAPP: Order ${orderId} from ${businessName} has been delivered. Enjoy! A receipt is in the app.`;
}

export function businessOrderReceivedSms(orderId: string, totalCents: number, customerPhone: string): string {
  return `SELLONAPP: New order ${orderId} of ${kwacha(totalCents)} from ${customerPhone}. Confirm it in the app.`;
}

export function newRiderSms(businessName: string): string {
  return `SELLONAPP: You have been added as a rider for ${businessName}. Accept deliveries in the app.`;
}

export function payoutSentSms(amountCents: number, businessName: string): string {
  return `SELLONAPP: Payout of ${kwacha(amountCents)} for ${businessName} sent to your mobile money. Check your wallet.`;
}

export function payoutFailedSms(amountCents: number, businessName: string): string {
  return `SELLONAPP: Payout of ${kwacha(amountCents)} for ${businessName} is delayed. We retry automatically.`;
}

export function businessApprovedSms(businessName: string): string {
  return `SELLONAPP: ${businessName} is approved! Add products and start selling in the app.`;
}

export function invoiceSms(invoiceNo: string, totalCents: number, businessName: string): string {
  return `SELLONAPP: Tax invoice ${invoiceNo} of ${kwacha(totalCents)} from ${businessName}. View it in the app.`;
}
