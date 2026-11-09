import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { members, otpCodes, users } from "../db/schema.js";
import { env } from "../env.js";
import { hmac, safeEqual, sixDigitCode } from "../lib/crypto.js";
import type { Phone } from "../lib/phone.js";
import { sendOtpViaInterakt } from "./interakt.js";

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export class OtpError extends Error {
  constructor(message: string, public status: 400 | 429 = 400) { super(message); }
}

const hashCode = (phone: string, code: string) => hmac(env.sessionSecret, `${phone}:${code}`);

/** Issues a code and sends it on WhatsApp. In dev mode the code is returned instead. */
export async function requestOtp(phone: Phone): Promise<{ devCode?: string }> {
  const db = getDb();
  const recent = await db.select({ createdAt: otpCodes.createdAt }).from(otpCodes)
    .where(and(eq(otpCodes.phone, phone.e164), gt(otpCodes.createdAt, new Date(Date.now() - 3600_000))))
    .orderBy(desc(otpCodes.createdAt));
  if (recent[0] && Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new OtpError("Please wait a few seconds before asking for another code.", 429);
  }
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    throw new OtpError("Too many codes requested. Try again in an hour.", 429);
  }

  const code = sixDigitCode();
  await db.insert(otpCodes).values({
    phone: phone.e164, codeHash: hashCode(phone.e164, code), expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  if (env.otpDevMode) {
    console.log(`[otp] dev mode — code for ${phone.e164}: ${code}`);
    return { devCode: code };
  }
  await sendOtpViaInterakt(phone, code);
  return {};
}

/** Checks the code; on success returns the (created if new) user and links pending invites. */
export async function verifyOtp(phone: Phone, code: string) {
  const db = getDb();
  if (!/^\d{6}$/.test(code)) throw new OtpError("Enter the 6-digit code.");
  const [otp] = await db.select().from(otpCodes)
    .where(and(eq(otpCodes.phone, phone.e164), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt)).limit(1);
  if (!otp) throw new OtpError("That code has expired. Ask for a new one.");
  if (otp.attempts >= MAX_ATTEMPTS) throw new OtpError("Too many wrong tries. Ask for a new code.", 429);

  if (!safeEqual(otp.codeHash, hashCode(phone.e164, code))) {
    await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(eq(otpCodes.id, otp.id));
    throw new OtpError("That code isn't right. Check WhatsApp and try again.");
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));

  await db.insert(users).values({ phone: phone.e164 }).onConflictDoNothing();
  let [user] = await db.select().from(users).where(eq(users.phone, phone.e164)).limit(1);
  // Anyone who was invited with this number joins those workspaces now.
  const joined = await db.update(members).set({ userId: user.id })
    .where(and(eq(members.phone, phone.e164), isNull(members.userId)))
    .returning({ name: members.name });
  // A teammate who was invited by name doesn't have to type it again.
  const invitedAs = joined.find((m) => m.name)?.name;
  if (!user.name && invitedAs) {
    [user] = await db.update(users).set({ name: invitedAs }).where(eq(users.id, user.id)).returning();
  }
  return user;
}
