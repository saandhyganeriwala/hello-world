// Plans, AI usage and limits.
//
// Every AI call (Claude, voice transcription) is priced and recorded against the workspace.
// Free: a one-off AI credit per *person* (₹20 by default), spent across the free workspaces
// they own. Pro (₹999 per 30 days): a fair-usage AI budget per workspace that resets every
// 30 days, plus more members. Upgrading early carries the unused free credit into the first
// Pro period, so nothing is lost. Without credit, CRUD
// still saves plain records with the on-device parser; questions, screenshots, imports and
// interface changes wait for an upgrade.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { aiUsage, members, payments, users, workspaces } from "../db/schema.js";
import { env } from "../env.js";
import type { AiUsage } from "../ai/claude.js";

// USD per million tokens. Cache writes are the 1-hour kind (2× input) — see src/ai/claude.ts.
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 4 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 4 },
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 8 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
};
const DAY = 864e5;

export function priceUsd(u: Pick<AiUsage, "model" | "input" | "output" | "cacheRead" | "cacheWrite">) {
  const key = Object.keys(PRICES).find((k) => u.model.startsWith(k)) ?? env.claudeModel;
  const p = PRICES[key] ?? PRICES["claude-sonnet-5-5"];
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

export async function recordUsage(workspaceId: string, userId: string | null, u: AiUsage, costUsdOverride?: number) {
  const costUsd = costUsdOverride ?? priceUsd(u), costInr = costUsd * env.usdInr, db = getDb();
  await db.insert(aiUsage).values({
    workspaceId, userId, label: u.label, model: u.model, inputTokens: u.input, outputTokens: u.output,
    cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite, costUsd, costInr,
  });
  // On the free plan, it comes out of the owner's personal free credit.
  const [w] = await db.select({ plan: workspaces.plan, planUntil: workspaces.planUntil, owner: workspaces.createdBy })
    .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const pro = w?.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > Date.now();
  if (w?.owner && !pro) await db.update(users).set({ freeSpentInr: sql`${users.freeSpentInr} + ${costInr}` }).where(eq(users.id, w.owner));
}

export type Billing = {
  plan: "free" | "pro"; planUntil: number | null; periodEnds: number | null;
  usedInr: number; limitInr: number; leftInr: number; ok: boolean; bonusInr: number;
  avgActionInr: number; actionsLeft: number; members: number; memberLimit: number;
  priceInr: number; proMembers: number; proActions: number; freeCreditInr: number; paymentsReady: boolean;
};

/** Where the workspace stands right now. */
export async function billingStatus(workspaceId: string): Promise<Billing> {
  const db = getDb();
  const [w] = await db.select({ plan: workspaces.plan, planUntil: workspaces.planUntil, periodStart: workspaces.periodStart,
    bonus: workspaces.bonusInr, owner: workspaces.createdBy }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const now = Date.now();
  const pro = w?.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > now;
  // Pro: the current 30-day window since the plan started. Free: everything ever used.
  let since: Date | null = null, periodEnds: number | null = null, firstPeriod = false;
  if (pro) {
    const start = (w!.periodStart ?? new Date(w!.planUntil!.getTime() - env.proDays * DAY)).getTime();
    const win = env.proDays * DAY, n = Math.max(0, Math.floor((now - start) / win));
    since = new Date(start + n * win); periodEnds = Math.min(start + (n + 1) * win, w!.planUntil!.getTime()); firstPeriod = n === 0;
  }
  let used = 0;
  if (pro) {
    [{ used }] = await db.select({ used: sql<number>`coalesce(sum(${aiUsage.costInr}), 0)::float8` }).from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.createdAt, since!)));
  } else if (w?.owner) {
    const [o] = await db.select({ spent: users.freeSpentInr }).from(users).where(eq(users.id, w.owner)).limit(1);
    used = o?.spent ?? 0;
  } else {
    [{ used }] = await db.select({ used: sql<number>`coalesce(sum(${aiUsage.costInr}), 0)::float8` }).from(aiUsage).where(eq(aiUsage.workspaceId, workspaceId));
  }
  const recent = await db.select({ c: aiUsage.costInr }).from(aiUsage).where(eq(aiUsage.workspaceId, workspaceId))
    .orderBy(desc(aiUsage.createdAt)).limit(40);
  const avg = recent.length >= 10 ? recent.reduce((a, r) => a + r.c, 0) / recent.length : env.actionInr;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.workspaceId, workspaceId));
  const bonusInr = pro && firstPeriod ? (w!.bonus ?? 0) : 0;
  const limitInr = pro ? env.proMonthlyAiInr + bonusInr : env.freeCreditInr;
  const leftInr = Math.max(0, limitInr - used);
  return {
    plan: pro ? "pro" : "free", planUntil: pro ? w!.planUntil!.getTime() : null, periodEnds,
    usedInr: round2(used), limitInr: round2(limitInr), leftInr: round2(leftInr), ok: leftInr > 0.01, bonusInr: round2(bonusInr),
    avgActionInr: round2(avg), actionsLeft: Math.floor(leftInr / Math.max(avg, 0.05)),
    members: n, memberLimit: pro ? env.proMembers : env.freeMembers,
    priceInr: env.proPriceInr, proMembers: env.proMembers, proActions: proActions(),
    freeCreditInr: env.freeCreditInr, paymentsReady: env.paymentsReady,
  };
}

/** The fair-usage allowance stated on the pricing page, in actions per 30 days. */
export function proActions() { return Math.round(env.proMonthlyAiInr / env.actionInr / 50) * 50; }
export function freeActions() { return Math.floor(env.freeCreditInr / env.actionInr / 5) * 5; }

/** Throws a friendly error when the workspace is full for its plan. */
export async function assertCanAddMember(workspaceId: string) {
  const b = await billingStatus(workspaceId);
  if (b.members >= b.memberLimit) {
    throw new LimitError(b.plan === "pro"
      ? `Pro workspaces can have up to ${b.memberLimit} people.`
      : `The free plan allows up to ${b.memberLimit} people. Upgrade to Pro for up to ${env.proMembers}.`);
  }
}
export class LimitError extends Error {}

/** Marks an order paid and extends Pro by one period. Safe to call twice for the same order. */
export async function activatePayment(orderId: string, paymentId: string) {
  return getDb().transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.orderId, orderId)).limit(1).for("update");
    if (!p) return { ok: false as const, reason: "unknown order" };
    if (p.status === "paid") return { ok: true as const, workspaceId: p.workspaceId, already: true };
    await tx.update(payments).set({ status: "paid", paymentId, paidAt: new Date() }).where(eq(payments.id, p.id));
    const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, p.workspaceId)).limit(1).for("update");
    const now = Date.now(), active = w.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > now;
    const until = new Date((active ? w.planUntil!.getTime() : now) + env.proDays * DAY);
    // Upgrading from free: the owner's unused free credit rides along into the first Pro period.
    let bonus = active ? w.bonusInr : 0;
    if (!active && w.createdBy) {
      const [o] = await tx.select({ spent: users.freeSpentInr }).from(users).where(eq(users.id, w.createdBy)).limit(1).for("update");
      bonus = Math.max(0, env.freeCreditInr - (o?.spent ?? 0));
      if (bonus > 0) await tx.update(users).set({ freeSpentInr: env.freeCreditInr }).where(eq(users.id, w.createdBy));
    }
    await tx.update(workspaces).set({ plan: "pro", planUntil: until, periodStart: active && w.periodStart ? w.periodStart : new Date(now), bonusInr: bonus })
      .where(eq(workspaces.id, p.workspaceId));
    return { ok: true as const, workspaceId: p.workspaceId, already: false };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
