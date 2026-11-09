import crypto from "node:crypto";

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const hmac = (secret: string, s: string) => crypto.createHmac("sha256", secret).update(s).digest("hex");
export const sixDigitCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
