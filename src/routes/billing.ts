// Razorpay Subscriptions: Pro is billed monthly and renews automatically until cancelled.
//   1. POST /workspaces/:id/billing/subscribe → creates a Razorpay subscription, returns what Checkout needs
//   2. Checkout.js in the browser takes the first payment and sets up the mandate (card / UPI Autopay)
//   3. POST /workspaces/:id/billing/verify    → checks the signature and switches the workspace to Pro
//   4. POST /billing/razorpay-webhook         → renewals (subscription.charged), cancellations, failures;
//                                               also activates Pro if the tab closed before step 3
//   5. POST /workspaces/:id/billing/cancel    → stops renewal at the end of the paid period
// Each charge is counted once per payment id, so 3 and 4 can both arrive.
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { razorpayPlans, subscriptions, workspaces } from "../db/schema.js";
import { env } from "../env.js";
import { requireUser, type AppEnv } from "../auth/session.js";
import { getMembership, loadState } from "../domain/state.js";
import { applyCharge, billingStatus, setSubscriptionStatus } from "../domain/billing.js";
import { publish } from "../realtime.js";

export const billing = new Hono<AppEnv>();
const hmacHex = (secret: string, data: string) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const sameHex = (a: string, b: string) => { const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8"); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;
const unix = (s: unknown) => (typeof s === "number" && s > 0 ? new Date(s * 1000) : null);

/** Calls the Razorpay API. Returns the JSON body, or null (and logs why) when it fails. */
export async function rzp(method: "GET" | "POST", path: string, payload?: unknown): Promise<any | null> {
  const res = await fetch(`${env.razorpayBaseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64") },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }).catch((e) => { console.error("[billing] razorpay request failed", method, path, e?.message); return null; });
  const data: any = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok) { console.error("[billing] razorpay error", method, path, res?.status, JSON.stringify(data).slice(0, 400)); return null; }
  return data;
}

/** The monthly Pro plan for a currency: from env, from the cache, or created now. */
async function planFor(currency: "INR" | "USD", amount: number) {
  const fixed = currency === "INR" ? env.razorpayPlanInr : env.razorpayPlanUsd;
  if (fixed) return fixed;
  const db = getDb(), key = `${env.razorpayKeyId}:${currency}:${amount}:monthly`;
  const [hit] = await db.select().from(razorpayPlans).where(eq(razorpayPlans.key, key)).limit(1);
  if (hit) return hit.planId;
  const plan = await rzp("POST", "/plans", {
    period: "monthly", interval: 1,
    item: { name: "CRUD.chat Pro", amount, currency, description: `Up to ${env.proMembers} people, ~${Math.round(env.proMonthlyAiInr / env.actionInr / 50) * 50} AI actions a month` },
    notes: { product: "crud.chat", plan: "pro" },
  });
  if (!plan?.id) return null;
  await db.insert(razorpayPlans).values({ key, planId: plan.id }).onConflictDoNothing();
  const [row] = await db.select().from(razorpayPlans).where(eq(razorpayPlans.key, key)).limit(1);
  return row?.planId ?? plan.id;
}

billing.use("/workspaces/:id/billing", requireUser);
billing.use("/workspaces/:id/billing/*", requireUser);

billing.get("/workspaces/:id/billing", async (c) => {
  if (!(await getMembership(c.get("user").id, c.req.param("id")!))) return c.json({ error: "Workspace not found." }, 404);
  return c.json({ billing: await billingStatus(c.req.param("id")!) });
});

billing.post("/workspaces/:id/billing/subscribe", async (c) => {
  const user = c.get("user"), id = c.req.param("id")!;
  if (!(await getMembership(user.id, id))) return c.json({ error: "Workspace not found." }, 404);
  if (!env.paymentsReady) return c.json({ error: "Payments aren't set up yet. Please try again later." }, 503);
  const now = await billingStatus(id);
  if (now.plan === "pro" && now.subscription && ["active", "pending", "cancelling"].includes(now.subscription.status)) {
    return c.json({ error: now.subscription.status === "cancelling"
      ? `This workspace is on Pro until ${new Date(now.periodEnds!).toDateString().slice(4)}. You can subscribe again after that.`
      : "This workspace is already on Pro." }, 409);
  }
  // India pays in rupees, everyone else in dollars. The country comes from the CDN when there is one
  // (Cloudflare's cf-ipcountry), otherwise from the browser's own guess (its time zone).
  const country = (c.req.header("cf-ipcountry") || c.req.header("x-vercel-ip-country") || "").toUpperCase();
  const region = String((await body(c)).region || "").toUpperCase();
  const india = country ? country === "IN" : region !== "INTL";
  if (!india && !env.razorpayInternational) return c.json({ error: "Payments from outside India open soon." }, 503);
  const currency = india ? "INR" : "USD";
  const amount = Math.round((india ? env.proPriceInr : env.proPriceUsd) * 100); // paise / cents
  const planId = await planFor(currency, amount);
  if (!planId) return c.json({ error: "Couldn't start the subscription. Please try again." }, 502);
  const sub = await rzp("POST", "/subscriptions", {
    plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1, // 120 months; renews until cancelled
    notes: { workspace_id: id, user_id: user.id, plan: "pro" },
  });
  if (!sub?.id) return c.json({ error: "Couldn't start the subscription. Please try again." }, 502);
  await getDb().insert(subscriptions).values({ workspaceId: id, userId: user.id, subscriptionId: sub.id, planId, amount, currency, status: sub.status || "created" });
  return c.json({
    keyId: env.razorpayKeyId, subscriptionId: sub.id, amount, currency,
    name: "CRUD.chat", description: `Pro · monthly · up to ${env.proMembers} people`,
    prefill: { name: user.name || "", email: user.email || "", contact: user.phone || "" },
  });
});

billing.post("/workspaces/:id/billing/verify", async (c) => {
  const user = c.get("user"), id = c.req.param("id")!;
  if (!(await getMembership(user.id, id))) return c.json({ error: "Workspace not found." }, 404);
  const b = await body(c);
  const subId = String(b.razorpay_subscription_id || ""), paymentId = String(b.razorpay_payment_id || ""), sig = String(b.razorpay_signature || "");
  if (!subId || !paymentId || !sig || !env.razorpayKeySecret) return c.json({ error: "Payment details missing." }, 400);
  if (!sameHex(hmacHex(env.razorpayKeySecret, `${paymentId}|${subId}`), sig)) {
    console.warn("[billing] bad subscription signature", subId);
    return c.json({ error: "We couldn't verify that payment. If money was taken, it will be confirmed shortly." }, 400);
  }
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.subscriptionId, subId)).limit(1);
  if (!row || row.workspaceId !== id) return c.json({ error: "That payment isn't for this workspace." }, 400);
  // The billing period comes from Razorpay; if it can't be fetched right now, a month from today
  // is used and the webhook corrects it.
  const live = await rzp("GET", `/subscriptions/${encodeURIComponent(subId)}`);
  const out = await applyCharge({ subscriptionId: subId, paymentId, periodStart: unix(live?.current_start), periodEnd: unix(live?.current_end) });
  if (!out.ok) return c.json({ error: "That payment isn't for this workspace." }, 400);
  publish(id, { type: "change", by: c.get("clientId") });
  console.log("[billing] pro activated", JSON.stringify({ workspace: id, subId, paymentId, via: "checkout", already: out.already }));
  return c.json({ state: await loadState(id, user.id) });
});

billing.post("/workspaces/:id/billing/cancel", async (c) => {
  const user = c.get("user"), id = c.req.param("id")!;
  const m = await getMembership(user.id, id);
  if (!m) return c.json({ error: "Workspace not found." }, 404);
  const [w] = await getDb().select({ subId: workspaces.subscriptionId, owner: workspaces.createdBy }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!w?.subId) return c.json({ error: "There's no subscription to cancel." }, 400);
  const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.subscriptionId, w.subId)).limit(1);
  if (sub && sub.userId !== user.id && w.owner !== user.id && m.role !== "owner") {
    return c.json({ error: "Only the person who subscribed, or the workspace owner, can cancel." }, 403);
  }
  if (sub && ["cancelling", "cancelled", "completed", "halted"].includes(sub.status)) return c.json({ state: await loadState(id, user.id) });
  // Stop at the end of the period already paid for — no refunds for a period that has started.
  const out = await rzp("POST", `/subscriptions/${encodeURIComponent(w.subId)}/cancel`, { cancel_at_cycle_end: 1 });
  if (!out) return c.json({ error: "Couldn't cancel right now. Please try again, or write to login@crud.chat." }, 502);
  await setSubscriptionStatus(w.subId, out.status === "cancelled" ? "cancelled" : "cancelling");
  publish(id, { type: "change", by: c.get("clientId") });
  console.log("[billing] subscription cancelled", JSON.stringify({ workspace: id, subId: w.subId, status: out.status }));
  return c.json({ state: await loadState(id, user.id) });
});

// Razorpay → us. Signed with the webhook secret over the raw body.
billing.post("/billing/razorpay-webhook", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-razorpay-signature") || "";
  if (!env.razorpayWebhookSecret || !sig || !sameHex(hmacHex(env.razorpayWebhookSecret, raw), sig)) {
    return c.json({ error: "bad signature" }, 400);
  }
  let ev: any; try { ev = JSON.parse(raw); } catch { return c.json({ error: "bad body" }, 400); }
  const event = String(ev.event || "");
  const sub = ev.payload?.subscription?.entity, pay = ev.payload?.payment?.entity;
  if (!event.startsWith("subscription.") || !sub?.id) return c.json({ ok: true });
  const changed = (wsId: string) => publish(wsId, { type: "change", by: "razorpay" });
  // A payment that went through (first charge or a renewal).
  if ((event === "subscription.charged" || event === "subscription.activated") && pay?.id && (!pay.status || pay.status === "captured")) {
    const out = await applyCharge({
      subscriptionId: sub.id, paymentId: pay.id, orderId: pay.order_id, amount: pay.amount, currency: pay.currency,
      periodStart: unix(sub.current_start), periodEnd: unix(sub.current_end),
    });
    if (out.ok) { changed(out.workspaceId); console.log("[billing] charge", JSON.stringify({ subId: sub.id, paymentId: pay.id, via: event, already: out.already })); }
    else console.warn("[billing] webhook for unknown subscription", sub.id, event);
    return c.json({ ok: true });
  }
  const status = event.slice("subscription.".length); // activated, authenticated, pending, halted, cancelled, completed, paused, resumed, updated
  const map: Record<string, string> = { activated: "active", resumed: "active", authenticated: "authenticated", pending: "pending", halted: "halted", cancelled: "cancelled", completed: "completed", paused: "paused" };
  if (map[status]) {
    const out = await setSubscriptionStatus(sub.id, map[status]);
    if (out.ok) { changed(out.workspaceId); console.log("[billing] subscription", JSON.stringify({ subId: sub.id, status: out.status })); }
    else console.warn("[billing] webhook for unknown subscription", sub.id, event);
  }
  return c.json({ ok: true });
});
