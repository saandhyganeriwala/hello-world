import { randomInt } from "node:crypto";

// No 0/O/1/I/L to avoid misreading when a merchant types the code by hand.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const LINK_CODE_LENGTH = 6;
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export function generateLinkCode(): string {
  let code = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++)
    code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Text the merchant sends from WhatsApp. Kept short and human so it does not look like spam. */
export function linkMessageText(code: string): string {
  return `Hi Storemate, connect my store. Code: LINK-${code}`;
}

/** Extracts a link code from an inbound WhatsApp message, tolerant of case and spacing. */
export function parseLinkCode(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = text.toUpperCase().match(/LINK\s*-?\s*([2-9A-HJ-NP-Z]{6})\b/);
  return match ? match[1] : null;
}

export function waMeLink(displayNumber: string, text: string): string {
  const digits = displayNumber.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
