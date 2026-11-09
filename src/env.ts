// Central configuration. Every value comes from environment variables;
// see .env.example for what each one does.

const bool = (v: string | undefined, d = false) =>
  v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v);

const isProd = process.env.NODE_ENV === "production";

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

  // Email OTP via Resend (resend.com).
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
    return this.loginMethod === "email" ? !!this.resendKey : !!(this.interaktKey && this.interaktTemplate);
  },

  // When true, the OTP is shown on screen instead of being sent.
  // Defaults to on in development when the sender isn't configured. Never
  // leave this on for real users in production.
  get otpDevMode() {
    return bool(process.env.OTP_DEV_MODE, !isProd && !this.otpProviderReady);
  },

  defaultCountry: (process.env.DEFAULT_COUNTRY || "IN") as any,
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
  console.log(`[config] login by ${env.loginMethod}`);
  if (env.otpDevMode) console.warn("[config] OTP_DEV_MODE is on — login codes are shown on screen, not sent.");
  else if (!env.otpProviderReady) {
    console.warn(env.loginMethod === "email"
      ? "[config] RESEND_API_KEY is not set — login will fail."
      : "[config] Interakt is not fully configured (INTERAKT_API_KEY / INTERAKT_OTP_TEMPLATE) — login will fail.");
  }
}
