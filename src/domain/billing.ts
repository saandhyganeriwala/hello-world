// Plans, AI usage and limits.
//
// Every AI call (Claude, voice transcription) is priced and recorded against the workspace.
// Free: a few AI actions per *person* (10 by default), across the free workspaces they own. Pro (₹999 per 30 days): a fair-usage AI budget per workspace that resets every
// 30 days, shown as actions, plus more members. Upgrading early carries unused free actions
// into the first Pro period, so nothing is lost. Without credit, CRUD
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
  // On the free plan it counts against the owner's personal free actions. A voice note's
  // transcription isn't an action of its own — the message it becomes is.
  const [w] = await db.select({ plan: workspaces.plan, planUntil: workspaces.planUntil, owner: workspaces.createdBy })
    .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const pro = w?.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > Date.now();
  if (w?.owner && !pro) {
    await db.update(users).set({
      freeSpentInr: sql`${users.freeSpentInr} + ${costInr}`,
      ...(isAction(u.label) ? { freeActionsUsed: sql`${users.freeActionsUsed} + 1` } : {}),
    }).where(eq(users.id, w.owner));
  }
}
const isAction = (label: string) => label !== "transcribe";

export type Billing = {
  plan: "free" | "pro"; planUntil: number | null; periodEnds: number | null; ok: boolean;
  actionsUsed: number; actionsLimit: number; actionsLeft: number; bonusActions: number;
  usedInr: number; members: number; memberLimit: number;
  priceInr: number; priceUsd: number; proMembers: number; proActions: number; freeActions: number;
  paymentsReady: boolean; usdPaymentsReady: boolean;
};

/** Where the workspace stands right now. Everything is shown in actions; Pro is metered in rupees underneath. */
export async function billingStatus(workspaceId: string): Promise<Billing> {
  const db = getDb();
  const [w] = await db.select({ plan: workspaces.plan, planUntil: workspaces.planUntil, periodStart: workspaces.periodStart,
    bonus: workspaces.bonusInr, owner: workspaces.createdBy }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const now = Date.now();
  const pro = w?.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > now;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.workspaceId, workspaceId));
  const common = {
    members: n, memberLimit: pro ? env.proMembers : env.freeMembers,
    priceInr: env.proPriceInr, priceUsd: env.proPriceUsd, proMembers: env.proMembers, proActions: proActions(), freeActions: env.freeActions,
    paymentsReady: env.paymentsReady, usdPaymentsReady: env.paymentsReady && env.razorpayInternational,
  };
  if (!pro) {
    let used = 0, usedInr = 0;
    if (w?.owner) {
      const [o] = await db.select({ a: users.freeActionsUsed, inr: users.freeSpentInr }).from(users).where(eq(users.id, w.owner)).limit(1);
      used = o?.a ?? 0; usedInr = o?.inr ?? 0;
    } else {
      [{ used }] = await db.select({ used: sql<number>`count(*)::int` }).from(aiUsage)
        .where(and(eq(aiUsage.workspaceId, workspaceId), sql`${aiUsage.label} <> 'transcribe'`));
    }
    const left = Math.max(0, env.freeActions - used);
    return { plan: "free", planUntil: null, periodEnds: null, ok: left > 0, actionsUsed: Math.min(used, env.freeActions), actionsLimit: env.freeActions,
      actionsLeft: left, bonusActions: 0, usedInr: round2(usedInr), ...common };
  }
  // Pro: the current 30-day window since the plan started, against the fair-usage budget.
  const start = (w!.periodStart ?? new Date(w!.planUntil!.getTime() - env.proDays * DAY)).getTime();
  const win = env.proDays * DAY, k = Math.max(0, Math.floor((now - start) / win));
  const since = new Date(start + k * win), periodEnds = Math.min(start + (k + 1) * win, w!.planUntil!.getTime());
  const [{ used }] = await db.select({ used: sql<number>`coalesce(sum(${aiUsage.costInr}), 0)::float8` }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.createdAt, since)));
  const bonusInr = k === 0 ? (w!.bonus ?? 0) : 0;
  const budget = env.proMonthlyAiInr + bonusInr, leftInr = Math.max(0, budget - used);
  const limit = Math.round(budget / env.actionInr), usedA = Math.min(limit, Math.round(used / env.actionInr));
  return { plan: "pro", planUntil: w!.planUntil!.getTime(), periodEnds, ok: leftInr > 0.01,
    actionsUsed: usedA, actionsLimit: limit, actionsLeft: Math.max(0, Math.floor(leftInr / env.actionInr)),
    bonusActions: Math.round(bonusInr / env.actionInr), usedInr: round2(used), ...common };
}

/** The fair-usage allowance stated on the pricing page, in actions per 30 days. */
export function proActions() { return Math.round(env.proMonthlyAiInr / env.actionInr / 50) * 50; }

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
    // Upgrading from free: the owner's unused free actions ride along into the first Pro period.
    let bonus = active ? w.bonusInr : 0;
    if (!active && w.createdBy) {
      const [o] = await tx.select({ used: users.freeActionsUsed }).from(users).where(eq(users.id, w.createdBy)).limit(1).for("update");
      const leftActions = Math.max(0, env.freeActions - (o?.used ?? 0));
      bonus = leftActions * env.actionInr;
      if (leftActions > 0) await tx.update(users).set({ freeActionsUsed: env.freeActions }).where(eq(users.id, w.createdBy));
    }
    await tx.update(workspaces).set({ plan: "pro", planUntil: until, periodStart: active && w.periodStart ? w.periodStart : new Date(now), bonusInr: bonus })
      .where(eq(workspaces.id, p.workspaceId));
    return { ok: true as const, workspaceId: p.workspaceId, already: false };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
