// Central configuration. Every value comes from environment variables;
// see .env.example for what each one does.

const bool = (v: string | undefined, d = false) =>
  v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v);

const isProd = process.env.NODE_ENV === "production";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v != null ? n : d; };
export const env = {
  isProd,
  port: Number(process.env.PORT || 3000),

  // Postgres connection string. When unset, an embedded Postgres (PGlite)
  // stored in PGLITE_DIR is used — handy for local development.
  databaseUrl: process.env.DATABASE_URL || "",
  pgliteDir: process.env.PGLITE_DIR || ".data/pglite",

  // Signs OTP hashes. Required in production.
  sessionSecret: process.env.SESSION_SECRET || (isProd ? "" : "dev-only-secret-change-me"),

  // Claude (the SDK also reads ANTHROPIC_API_KEY itself).
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  effortChat: (process.env.CLAUDE_EFFORT_CHAT || "low") as Effort,
  effortHeavy: (process.env.CLAUDE_EFFORT_HEAVY || "medium") as Effort,
  claudeFallbacks: bool(process.env.CLAUDE_FALLBACKS, true),

  // How people log in: "email" (code sent by email via Resend) or "whatsapp" (code via Interakt).
  loginMethod: ((process.env.LOGIN_METHOD || "email").toLowerCase() === "whatsapp" ? "whatsapp" : "email") as "email" | "whatsapp",

  // Email OTP: Brevo (brevo.com) or Resend (resend.com). EMAIL_PROVIDER picks; otherwise whichever key is set.
  brevoKey: process.env.BREVO_API_KEY || "",
  brevoBaseUrl: (process.env.BREVO_BASE_URL || "https://api.brevo.com/v3").replace(/\/$/, ""),
  get emailProvider(): "brevo" | "resend" | "" {
    const want = (process.env.EMAIL_PROVIDER || "").toLowerCase();
    if (want === "brevo") return this.brevoKey ? "brevo" : "";
    if (want === "resend") return this.resendKey ? "resend" : "";
    return this.brevoKey ? "brevo" : this.resendKey ? "resend" : "";
  },
  resendKey: process.env.RESEND_API_KEY || "",
  resendBaseUrl: (process.env.RESEND_BASE_URL || "https://api.resend.com").replace(/\/$/, ""),
  // Must be on a domain you've verified in Resend, e.g. "CRUD.chat <login@crud.chat>".
  emailFrom: process.env.EMAIL_FROM || "CRUD.chat <onboarding@resend.dev>",

  // WhatsApp OTP via Interakt.
  interaktKey: process.env.INTERAKT_API_KEY || "",
  interaktBaseUrl: (process.env.INTERAKT_BASE_URL || "https://api.interakt.ai").replace(/\/$/, ""),
  interaktTemplate: process.env.INTERAKT_OTP_TEMPLATE || "",
  interaktLang: process.env.INTERAKT_TEMPLATE_LANG || "en",
  // Authentication templates with a "Copy code" button need the code passed
  // to the button too. Turn off if your template has no button.
  interaktOtpButton: bool(process.env.INTERAKT_OTP_BUTTON, true),

  /** True when the chosen login method has the credentials it needs to send codes. */
  get otpProviderReady() {
    return this.loginMethod === "email" ? !!this.emailProvider : !!(this.interaktKey && this.interaktTemplate);
  },

  // When true, the OTP is shown on screen instead of being sent.
  // Defaults to on in development when the sender isn't configured. Never
  // leave this on for real users in production.
  get otpDevMode() {
    return bool(process.env.OTP_DEV_MODE, !isProd && !this.otpProviderReady);
  },

  defaultCountry: (process.env.DEFAULT_COUNTRY || "IN") as any,

  // ---- Plans & usage ----
  // Every Claude call is priced from its token counts (USD) and converted to rupees.
  usdInr: num(process.env.USD_INR, 88),
  actionInr: num(process.env.ACTION_INR, 0.45),               // typical cost of one AI action, for "≈ N actions" (from real usage)
  freeActions: num(process.env.FREE_ACTIONS, 10),             // free AI actions per person
  freeMembers: num(process.env.FREE_MEMBERS, 3),
  proPriceInr: num(process.env.PRO_PRICE_INR, 499),           // per month, in India (billed monthly by Razorpay Subscriptions)
  proPriceUsd: num(process.env.PRO_PRICE_USD, 6),             // per month, everywhere else
  proDays: num(process.env.PRO_DAYS, 30),                     // length of a period when Razorpay doesn't say
  proMembers: num(process.env.PRO_MEMBERS, 10),
  proMonthlyAiInr: num(process.env.PRO_MONTHLY_AI_INR, 225),  // fair-usage AI budget per month (≈ 500 actions at ACTION_INR)
  proGraceDays: num(process.env.PRO_GRACE_DAYS, 3),           // Pro stays on this long past a renewal date while Razorpay retries
  // ---- Voice transcription (see src/ai/transcribe.ts) ----
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER || "").toLowerCase(), // "openai" | "sarvam" | "" (auto)
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
  sarvamKey: process.env.SARVAM_API_KEY || "",
  sarvamBaseUrl: (process.env.SARVAM_BASE_URL || "https://api.sarvam.ai").replace(/\/$/, ""),
  sarvamMode: process.env.SARVAM_MODE || "codemix",
  sarvamInrPerHour: num(process.env.SARVAM_INR_PER_HOUR, 30),
  // ---- Razorpay (payments) ----
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  razorpayBaseUrl: (process.env.RAZORPAY_BASE_URL || "https://api.razorpay.com/v1").replace(/\/$/, ""),
  get paymentsReady() { return !!(this.razorpayKeyId && this.razorpayKeySecret); },
  // Optional: use plans you created in the Razorpay dashboard. Otherwise they're created on first use.
  razorpayPlanInr: process.env.RAZORPAY_PLAN_ID_INR || "",
  razorpayPlanUsd: process.env.RAZORPAY_PLAN_ID_USD || "",
  // USD orders need International Payments (and USD) enabled on the Razorpay account.
  razorpayInternational: bool(process.env.RAZORPAY_INTERNATIONAL, false),
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function assertProdConfig() {
  const missing: string[] = [];
  if (isProd && !env.sessionSecret) missing.push("SESSION_SECRET");
  if (isProd && !env.databaseUrl) missing.push("DATABASE_URL");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  if (!env.anthropicKey) console.warn("[config] ANTHROPIC_API_KEY not set — using the on-device fallback parser (no questions/commands).");
  console.log(`[config] login by ${env.loginMethod}${env.loginMethod === "email" && env.emailProvider ? ` (via ${env.emailProvider})` : ""}`);
  if (env.otpDevMode) console.warn("[config] OTP_DEV_MODE is on — login codes are shown on screen, not sent.");
  else if (!env.otpProviderReady) {
    console.warn(env.loginMethod === "email"
      ? "[config] No email provider (BREVO_API_KEY or RESEND_API_KEY) — login will fail."
      : "[config] Interakt is not fully configured (INTERAKT_API_KEY / INTERAKT_OTP_TEMPLATE) — login will fail.");
  }
}
