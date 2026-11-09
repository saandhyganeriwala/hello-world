// Sends the login code by email through Resend (https://resend.com).
//   POST https://api.resend.com/emails   Authorization: Bearer <RESEND_API_KEY>
// EMAIL_FROM must use a domain verified in Resend (e.g. login@crud.chat).
// Until a domain is verified, Resend only delivers to your own account email.
import { env } from "../env.js";
import { OtpSendError } from "./errors.js";

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  if (!env.resendKey) throw new OtpSendError("Email login isn't configured yet.");
  const text = `Your CRUD.chat code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#FBFAF7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1B1A16">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:420px;background:#fff;border:1px solid #E6E2D8;border-radius:16px" cellpadding="0" cellspacing="0">
<tr><td style="padding:32px 28px">
<div style="font-weight:800;font-size:18px;letter-spacing:-.01em">CRUD.chat</div>
<p style="margin:20px 0 8px;font-size:15px;color:#4C4940">Your login code</p>
<div style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:8px">${code}</div>
<p style="margin:20px 0 0;font-size:13px;color:#8A857A;line-height:1.5">It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;

  const res = await fetch(`${env.resendBaseUrl}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject: `${code} is your CRUD.chat code`, text, html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error("[email] send failed", res.status, (await res.text()).slice(0, 500));
    throw new OtpSendError("Couldn't send the code. Try again in a minute.");
  }
}
