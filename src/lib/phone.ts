import { parsePhoneNumberFromString } from "libphonenumber-js";
import { env } from "../env.js";

export type Phone = { e164: string; countryCode: string; national: string };

/** Normalizes "98765 43210" / "+91 98765-43210" to E.164, or returns null if invalid. */
export function normalizePhone(input: unknown): Phone | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const p = parsePhoneNumberFromString(input.trim(), env.defaultCountry);
  if (!p || !p.isValid()) return null;
  return { e164: p.number, countryCode: "+" + p.countryCallingCode, national: p.nationalNumber };
}

/** "+919876543210" → "+91 ••••• 43210" for showing other people's numbers. */
export function maskPhone(e164: string) {
  return e164.length > 6 ? e164.slice(0, 3) + " ••••• " + e164.slice(-5) : e164;
}
