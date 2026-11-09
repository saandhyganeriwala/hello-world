import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { env } from "../env.js";
import { randomToken, sha256 } from "../lib/crypto.js";

const COOKIE = "crud_session";
const MAX_AGE_DAYS = 30;

export type AuthUser = { id: string; email: string | null; phone: string | null; name: string | null };
export type AppEnv = { Variables: { user: AuthUser; clientId: string } };

export async function createSession(c: Context, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + MAX_AGE_DAYS * 864e5);
  await getDb().insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: env.isProd, sameSite: "Lax", path: "/", maxAge: MAX_AGE_DAYS * 86400,
  });
}

export async function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, COOKIE, { path: "/" });
}

async function userFromCookie(c: Context): Promise<AuthUser | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const rows = await getDb()
    .select({ id: users.id, email: users.email, phone: users.phone, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

/** Rejects with 401 unless a valid session cookie is present. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await userFromCookie(c);
  if (!user) return c.json({ error: "Please log in." }, 401);
  c.set("user", user);
  c.set("clientId", c.req.header("x-client-id") || "");
  await next();
};
