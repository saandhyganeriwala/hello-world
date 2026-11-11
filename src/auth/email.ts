// Sends the login code by email, through Brevo or Resend (EMAIL_PROVIDER, or whichever key is set).
//   Brevo:  POST https://api.brevo.com/v3/smtp/email   api-key: <BREVO_API_KEY>
//   Resend: POST https://api.resend.com/emails         Authorization: Bearer <RESEND_API_KEY>
// EMAIL_FROM ("CRUD.chat <login@crud.chat>") must use a domain (or sender) verified with that provider.
import { env } from "../env.js";
import { OtpSendError } from "./errors.js";

/** "CRUD.chat <login@crud.chat>" → { name: "CRUD.chat", email: "login@crud.chat" } */
export function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || "CRUD.chat", email: m[2].trim() } : { name: "CRUD.chat", email: from.trim() };
}

function bodies(code: string) {
  const text = `Your CRUD.chat code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#F4F2EC;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141414">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:420px;background:#FFFEFA;border:2px solid #141414;border-radius:18px" cellpadding="0" cellspacing="0">
<tr><td style="padding:32px 28px">
<div style="font-weight:800;font-size:18px;letter-spacing:-.01em">CRUD<span style="color:#B98700">.chat</span></div>
<p style="margin:20px 0 10px;font-size:15px;color:#46433D">Your login code</p>
<div style="display:inline-block;background:#FFC31F;border:2px solid #141414;border-radius:12px;padding:10px 16px;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:8px">${code}</div>
<p style="margin:22px 0 0;font-size:13px;color:#85817A;line-height:1.5">It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html, subject: `${code} is your CRUD.chat code` };
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const provider = env.emailProvider;
  if (!provider) throw new OtpSendError("Email login isn't configured yet.");
  const { text, html, subject } = bodies(code);
  let res: Response;
  if (provider === "brevo") {
    res = await fetch(`${env.brevoBaseUrl}/smtp/email`, {
      method: "POST",
      headers: { "api-key": env.brevoKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: parseFrom(env.emailFrom), to: [{ email: to }], subject, htmlContent: html, tags: ["login-code"] }),
      signal: AbortSignal.timeout(15_000),
    });
  } else {
    res = await fetch(`${env.resendBaseUrl}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (!res.ok) {
    console.error(`[email] ${provider} send failed`, res.status, (await res.text()).slice(0, 500));
    throw new OtpSendError("Couldn't send the code. Try again in a minute.");
  }
}
