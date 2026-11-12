import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { members, otpCodes, users } from "../db/schema.js";
import { env } from "../env.js";
import { hmac, safeEqual, sixDigitCode } from "../lib/crypto.js";
import type { Identity } from "../lib/identity.js";
import { sendOtpEmail } from "./email.js";
import { sendOtpViaInterakt } from "./interakt.js";

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export class OtpError extends Error {
  constructor(message: string, public status: 400 | 429 = 400) { super(message); }
}

const hashCode = (target: string, code: string) => hmac(env.sessionSecret, `${target}:${code}`);
const checkHint = (id: Identity) => (id.kind === "email" ? "Check your email" : "Check WhatsApp");

/** Issues a code and sends it by email or WhatsApp. In dev mode the code is returned instead. */
export async function requestOtp(id: Identity): Promise<{ devCode?: string }> {
  const db = getDb();
  const recent = await db.select({ createdAt: otpCodes.createdAt }).from(otpCodes)
    .where(and(eq(otpCodes.target, id.value), gt(otpCodes.createdAt, new Date(Date.now() - 3600_000))))
    .orderBy(desc(otpCodes.createdAt));
  if (recent[0] && Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new OtpError("Please wait a few seconds before asking for another code.", 429);
  }
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    throw new OtpError("Too many codes requested. Try again in an hour.", 429);
  }

  // The store reviewers' demo account signs in with a fixed code instead of a sent one.
  const review = env.reviewLogin && id.kind === "email" && id.value === env.reviewLogin.email ? env.reviewLogin.code : null;
  const code = review ?? sixDigitCode();
  await db.insert(otpCodes).values({
    target: id.value, codeHash: hashCode(id.value, code), expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  if (review) return {};
  if (env.otpDevMode) {
    console.log(`[otp] dev mode — code for ${id.value}: ${code}`);
    return { devCode: code };
  }
  if (id.kind === "email") await sendOtpEmail(id.value, code);
  else await sendOtpViaInterakt(id.phone, code);
  return {};
}

/** Checks the code; on success returns the (created if new) user and links pending invites. */
export async function verifyOtp(id: Identity, code: string) {
  const db = getDb();
  if (!/^\d{6}$/.test(code)) throw new OtpError("Enter the 6-digit code.");
  const [otp] = await db.select().from(otpCodes)
    .where(and(eq(otpCodes.target, id.value), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt)).limit(1);
  if (!otp) throw new OtpError("That code has expired. Ask for a new one.");
  if (otp.attempts >= MAX_ATTEMPTS) throw new OtpError("Too many wrong tries. Ask for a new code.", 429);

  if (!safeEqual(otp.codeHash, hashCode(id.value, code))) {
    await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(eq(otpCodes.id, otp.id));
    throw new OtpError(`That code isn't right. ${checkHint(id)} and try again.`);
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));

  const userCol = id.kind === "email" ? users.email : users.phone;
  const memberCol = id.kind === "email" ? members.email : members.phone;
  await db.insert(users).values(id.kind === "email" ? { email: id.value } : { phone: id.value }).onConflictDoNothing();
  let [user] = await db.select().from(users).where(eq(userCol, id.value)).limit(1);

  // Anyone invited with this email/number joins those workspaces now.
  const joined = await db.update(members).set({ userId: user.id })
    .where(and(eq(memberCol, id.value), isNull(members.userId)))
    .returning({ name: members.name });
  // A teammate who was invited by name doesn't have to type it again.
  const invitedAs = joined.find((m) => m.name)?.name;
  if (!user.name && invitedAs) {
    [user] = await db.update(users).set({ name: invitedAs }).where(eq(users.id, user.id)).returning();
  }
  return user;
}
