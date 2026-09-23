// SMS delivery via Africa's Talking (OTP + order/business notifications).
// Sign up: https://africastalking.com | Docs: https://apidocs.africastalking.com/
export interface SmsEnv {
  AT_USERNAME: string;
  AT_API_KEY: string;
  AT_FROM?: string;
  ENV: string;
}

const AT_MESSAGES_URL = "https://api.africastalking.com/version1/messaging";

/** Africa's Talking requires E.164, no leading 0. Assumes +260 Zambian numbers. */
export function safePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) return `+260${digits.slice(1)}`;
  return digits.startsWith("260") ? `+${digits}` : `+${digits}`;
}

/** Normalize to bare 260 form (no +) for storage. */
export function normPhone(phone: string): string {
  return safePhone(phone).replace(/^\+/, "");
}

/** Sends a branded SMS via Africa's Talking.
 *  - ENV=production -> real AT API call (requires AT_API_KEY secret).
 *  - other          -> logged only (no network, no billing during dev/sandbox).
 */
export async function sendSms(env: SmsEnv, phone: string, message: string): Promise<void> {
  if (env.ENV !== "production") {
    console.log(`[SMS ${phone}] ${message}`);
    return;
  }

  const send = async (from?: string) => {
    const form = new URLSearchParams({
      username: env.AT_USERNAME,
      to: safePhone(phone),
      message: message,
      ...(from ? { from } : {}),
    });
    const res = await fetch(AT_MESSAGES_URL, {
      method: "POST",
      headers: {
        Apikey: env.AT_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const body = await res.text().catch(() => "");
    if (res.ok) return;
    throw new Error(`Africa's Talking SMS failed (${res.status}): ${body || "empty body"}`);
  };

  try {
    const sender = (env.AT_FROM && env.AT_FROM.trim()) ? env.AT_FROM.trim() : "KSPONSOR";
    await send(sender);
  } catch (e) {
    // AT returns 400 with "Invalid senderId" until a sender ID is approved.
    // Fall back to the account's default sender so OTPs keep flowing.
    if (String(e).includes("(400)")) {
      console.error("[SMS] sender ID rejected, retrying without FROM:", String(e).slice(0, 200));
      await send(undefined);
      return;
    }
    throw e;
  }
}
