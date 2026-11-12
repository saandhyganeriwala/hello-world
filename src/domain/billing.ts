// Plans, AI usage and limits.
//
// Every AI call (Claude, voice transcription) is priced and recorded against the workspace.
// Free: a few AI actions per *person* (10 by default), across the free workspaces they own.
// Pro (₹499 a month, a Razorpay subscription that renews automatically): a fair-usage AI budget
// per workspace that resets with each billing period, shown as actions (≈ 500), plus more
// members. Upgrading early carries unused free actions
// into the first Pro period, so nothing is lost. Without credit, CRUD
// still saves plain records with the on-device parser; questions, screenshots, imports and
// interface changes wait for an upgrade.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { aiUsage, members, payments, subscriptions, users, workspaces } from "../db/schema.js";
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
  /** Pro only: next automatic charge (null once cancelled). */
  renewsAt: number | null;
  /** The workspace's subscription, if it has one: active, pending (a renewal is being retried), cancelling, cancelled, halted. */
  subscription: { status: string; currency: string; amount: number } | null;
};

/** Where the workspace stands right now. Everything is shown in actions; Pro is metered in rupees underneath. */
export async function billingStatus(workspaceId: string): Promise<Billing> {
  const db = getDb();
  const [w] = await db.select({ plan: workspaces.plan, planUntil: workspaces.planUntil, periodStart: workspaces.periodStart,
    renewsAt: workspaces.renewsAt, subId: workspaces.subscriptionId,
    bonus: workspaces.bonusInr, owner: workspaces.createdBy }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const now = Date.now();
  const pro = w?.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > now;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.workspaceId, workspaceId));
  const common = {
    members: n, memberLimit: pro ? env.proMembers : env.freeMembers,
    priceInr: env.proPriceInr, priceUsd: env.proPriceUsd, proMembers: env.proMembers, proActions: proActions(), freeActions: env.freeActions,
    paymentsReady: env.paymentsReady, usdPaymentsReady: env.paymentsReady && env.razorpayInternational,
    subscription: null as Billing["subscription"], renewsAt: null as number | null,
  };
  if (w?.subId) {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.subscriptionId, w.subId)).limit(1);
    if (sub) common.subscription = { status: sub.status, currency: sub.currency, amount: sub.amount };
  }
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
  // Pro: usage since the current billing period began, against the fair-usage budget.
  // Subscriptions set period_start and renews_at on every charge. (Older one-time payments
  // have no renews_at, so their periods are counted in fixed 30-day windows.)
  let since: Date, periodEnds: number, bonusInr: number;
  if (w!.renewsAt) {
    since = w!.periodStart ?? new Date(w!.renewsAt.getTime() - env.proDays * DAY);
    periodEnds = w!.renewsAt.getTime();
    bonusInr = w!.bonus ?? 0; // cleared by the first renewal
  } else {
    const start = (w!.periodStart ?? new Date(w!.planUntil!.getTime() - env.proDays * DAY)).getTime();
    const win = env.proDays * DAY, k = Math.max(0, Math.floor((now - start) / win));
    since = new Date(start + k * win); periodEnds = Math.min(start + (k + 1) * win, w!.planUntil!.getTime());
    bonusInr = k === 0 ? (w!.bonus ?? 0) : 0;
  }
  const [{ used }] = await db.select({ used: sql<number>`coalesce(sum(${aiUsage.costInr}), 0)::float8` }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.createdAt, since)));
  const budget = env.proMonthlyAiInr + bonusInr, leftInr = Math.max(0, budget - used);
  const limit = Math.round(budget / env.actionInr), usedA = Math.min(limit, Math.round(used / env.actionInr));
  const renews = common.subscription && ["active", "pending"].includes(common.subscription.status) ? periodEnds : null;
  return { plan: "pro", planUntil: w!.planUntil!.getTime(), periodEnds, ok: leftInr > 0.01,
    actionsUsed: usedA, actionsLimit: limit, actionsLeft: Math.max(0, Math.floor(leftInr / env.actionInr)),
    bonusActions: Math.round(bonusInr / env.actionInr), usedInr: round2(used), ...common, renewsAt: renews };
}

/** The fair-usage allowance stated on the pricing page, in actions per 30 days. */
export function proActions() { return Math.round(env.proMonthlyAiInr / env.actionInr / 50) * 50; }

/** Throws a friendly error when the workspace is full for its plan. */
export async function assertCanAddMember(workspaceId: string) {
  const b = await billingStatus(workspaceId);
  if (b.members >= b.memberLimit) {
    throw new LimitError(b.plan === "pro"
      ? `Pro workspaces can have up to ${b.memberLimit} people.`
      : `The free plan allows up to ${b.memberLimit} people (Pro allows ${env.proMembers}).`);
  }
}
export class LimitError extends Error {}

/** One month after `d`, same day of the month where it exists (31 Jan → 28/29 Feb). */
export function addMonth(d: Date) {
  const x = new Date(d); const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + 1);
  x.setUTCDate(Math.min(day, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}

export type Charge = {
  subscriptionId: string; paymentId: string; orderId?: string; amount?: number; currency?: string;
  /** The billing period this charge pays for, from Razorpay (unix seconds → Date). */
  periodStart?: Date | null; periodEnd?: Date | null;
};

/**
 * A subscription payment went through (the first one at checkout, or a monthly renewal):
 * Pro for the period it pays for. Safe to call twice for the same payment — the checkout
 * callback and the webhook both report the first one.
 */
export async function applyCharge(ch: Charge) {
  return getDb().transaction(async (tx) => {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.subscriptionId, ch.subscriptionId)).limit(1).for("update");
    if (!sub) return { ok: false as const, reason: "unknown subscription" };
    const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, sub.workspaceId)).limit(1).for("update");
    const grace = env.proGraceDays * DAY;
    const [seen] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.paymentId, ch.paymentId)).limit(1);
    if (seen) {
      // Already counted. The webhook knows the period better than the checkout callback's guess, so
      // take Razorpay's dates when they're later or a small correction (not an old, re-sent event).
      const diff = ch.periodEnd && w.renewsAt ? ch.periodEnd.getTime() - w.renewsAt.getTime() : 0;
      if (ch.periodEnd && w.subscriptionId === sub.subscriptionId && (!w.renewsAt || diff > 0 || Math.abs(diff) < 5 * DAY)) {
        await tx.update(workspaces).set({ renewsAt: ch.periodEnd, planUntil: new Date(ch.periodEnd.getTime() + grace),
          ...(ch.periodStart ? { periodStart: ch.periodStart } : {}) }).where(eq(workspaces.id, w.id));
      }
      return { ok: true as const, workspaceId: sub.workspaceId, already: true };
    }
    await tx.insert(payments).values({
      workspaceId: sub.workspaceId, userId: sub.userId, orderId: ch.orderId || ch.paymentId, paymentId: ch.paymentId,
      subscriptionId: sub.subscriptionId, amount: ch.amount ?? sub.amount, currency: ch.currency ?? sub.currency,
      status: "paid", paidAt: new Date(),
    });
    const now = Date.now(), active = w.plan === "pro" && !!w.planUntil && w.planUntil.getTime() > now;
    const start = ch.periodStart ?? new Date(now), end = ch.periodEnd && ch.periodEnd.getTime() > now ? ch.periodEnd : addMonth(start);
    // Upgrading from free: the owner's unused free actions ride along into the first Pro period.
    // A renewal starts a fresh period, so any carried-over actions end with the first one.
    let bonus = 0;
    if (!active && w.createdBy) {
      const [o] = await tx.select({ used: users.freeActionsUsed }).from(users).where(eq(users.id, w.createdBy)).limit(1).for("update");
      const leftActions = Math.max(0, env.freeActions - (o?.used ?? 0));
      bonus = leftActions * env.actionInr;
      if (leftActions > 0) await tx.update(users).set({ freeActionsUsed: env.freeActions }).where(eq(users.id, w.createdBy));
    }
    await tx.update(workspaces).set({ plan: "pro", periodStart: start, renewsAt: end, planUntil: new Date(end.getTime() + grace),
      subscriptionId: sub.subscriptionId, bonusInr: bonus }).where(eq(workspaces.id, w.id));
    await tx.update(subscriptions).set({ status: sub.status === "cancelling" ? "cancelling" : "active", currentEnd: end, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));
    return { ok: true as const, workspaceId: sub.workspaceId, already: false };
  });
}

/**
 * The subscription changed state without a payment.
 *  - active / authenticated / pending: noted (pending = a renewal failed and Razorpay is retrying; Pro carries on through the grace days)
 *  - cancelling: the owner cancelled; Pro stays until the end of the period already paid for
 *  - cancelled / completed: no more charges; Pro ends when the paid period does
 *  - halted / paused: retries ran out (or it was paused); back to free now
 */
export async function setSubscriptionStatus(subscriptionId: string, status: string) {
  return getDb().transaction(async (tx) => {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.subscriptionId, subscriptionId)).limit(1).for("update");
    if (!sub) return { ok: false as const };
    // A scheduled cancellation stays "cancelling" until Razorpay actually cancels it.
    const next = sub.status === "cancelling" && ["active", "authenticated", "pending"].includes(status) ? "cancelling" : status;
    await tx.update(subscriptions).set({ status: next, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, sub.workspaceId)).limit(1).for("update");
    if (w?.subscriptionId === subscriptionId && w.planUntil) {
      const now = Date.now();
      let until: number | null = null;
      if (next === "cancelled" || next === "completed") until = Math.max(now, w.renewsAt?.getTime() ?? now);
      if (next === "halted" || next === "paused") until = now;
      if (until !== null && until < w.planUntil.getTime()) {
        await tx.update(workspaces).set({ planUntil: new Date(until) }).where(eq(workspaces.id, w.id));
      }
    }
    return { ok: true as const, workspaceId: sub.workspaceId, status: next };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
