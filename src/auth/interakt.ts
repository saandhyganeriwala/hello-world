// Sends the login code as a WhatsApp Authentication template via Interakt.
//
// Interakt's "Send Template Message" API:
//   POST {INTERAKT_BASE_URL}/v1/public/message/
//   Authorization: Basic <API key from Interakt → Settings → Developer Setting>
// The template must be an approved WhatsApp "Authentication" template whose
// body has one variable ({{1}}) for the code. If it has a "Copy code" button,
// the code is also passed to the button (INTERAKT_OTP_BUTTON=true).
//
// VERIFY against Interakt's current docs when the account is set up — field
// names here follow their public template-message API.
import { env } from "../env.js";
import type { Phone } from "../lib/phone.js";
import { OtpSendError } from "./errors.js";

export async function sendOtpViaInterakt(phone: Phone, code: string): Promise<void> {
  if (!env.interaktKey || !env.interaktTemplate) {
    throw new OtpSendError("WhatsApp login isn't configured yet.");
  }
  const body: Record<string, unknown> = {
    countryCode: phone.countryCode,
    phoneNumber: phone.national,
    callbackData: "crudchat_otp",
    type: "Template",
    template: {
      name: env.interaktTemplate,
      languageCode: env.interaktLang,
      bodyValues: [code],
      ...(env.interaktOtpButton ? { buttonValues: { "0": [code] } } : {}),
    },
  };
  const res = await fetch(`${env.interaktBaseUrl}/v1/public/message/`, {
    method: "POST",
    headers: { Authorization: `Basic ${env.interaktKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok || data?.result === false) {
    console.error("[interakt] send failed", res.status, text.slice(0, 500));
    throw new OtpSendError("Couldn't send the WhatsApp code. Try again in a minute.");
  }
}
