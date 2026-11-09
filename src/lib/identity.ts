// What a person logs in with: an email address or a WhatsApp number,
// depending on LOGIN_METHOD.
import { env } from "../env.js";
import { maskPhone, normalizePhone, type Phone } from "./phone.js";

export type Identity =
  | { kind: "email"; value: string }
  | { kind: "phone"; value: string; phone: Phone };

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

/** Parses what someone typed into the login (or invite) box for the current login method. */
export function normalizeIdentity(input: unknown): Identity | null {
  if (env.loginMethod === "email") {
    const e = normalizeEmail(input);
    return e ? { kind: "email", value: e } : null;
  }
  const p = normalizePhone(input);
  return p ? { kind: "phone", value: p.e164, phone: p } : null;
}

export const invalidIdentityMessage = () =>
  env.loginMethod === "email" ? "Enter a valid email address." : "Enter a valid mobile number.";

/** "saandhy@shop.in" → "sa•••@shop.in" for showing other people's addresses. */
export function maskEmail(e: string) {
  const [user, domain] = e.split("@");
  if (!domain) return e;
  return (user.length <= 2 ? user[0] + "•" : user.slice(0, 2) + "•••") + "@" + domain;
}

export const maskContact = (v: string | null | undefined) =>
  !v ? "" : v.includes("@") ? maskEmail(v) : maskPhone(v);
