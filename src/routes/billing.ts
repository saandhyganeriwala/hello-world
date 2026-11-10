// Razorpay: Pro is a one-time payment for 30 days (pay again to extend).
//   1. POST /workspaces/:id/billing/order  → creates a Razorpay order, returns what Checkout needs
//   2. Checkout.js in the browser takes the payment
//   3. POST /workspaces/:id/billing/verify → checks the signature and switches the workspace to Pro
//   4. POST /billing/razorpay-webhook      → same activation from Razorpay's side, in case the tab closed
// Activation is idempotent per order, so 3 and 4 can both arrive.
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { getDb } from "../db/client.js";
import { payments } from "../db/schema.js";
import { env } from "../env.js";
import { requireUser, type AppEnv } from "../auth/session.js";
import { getMembership, loadState } from "../domain/state.js";
import { activatePayment, billingStatus } from "../domain/billing.js";
import { publish } from "../realtime.js";

export const billing = new Hono<AppEnv>();
const hmacHex = (secret: string, data: string) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const sameHex = (a: string, b: string) => { const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8"); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;

billing.use("/workspaces/:id/billing", requireUser);
billing.use("/workspaces/:id/billing/*", requireUser);

billing.get("/workspaces/:id/billing", async (c) => {
  if (!(await getMembership(c.get("user").id, c.req.param("id")!))) return c.json({ error: "Workspace not found." }, 404);
  return c.json({ billing: await billingStatus(c.req.param("id")!) });
});

billing.post("/workspaces/:id/billing/order", async (c) => {
  const user = c.get("user"), id = c.req.param("id")!;
  if (!(await getMembership(user.id, id))) return c.json({ error: "Workspace not found." }, 404);
  if (!env.paymentsReady) return c.json({ error: "Payments aren't set up yet. Please try again later." }, 503);
  const amount = Math.round(env.proPriceInr * 100); // paise
  const res = await fetch(`${env.razorpayBaseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64") },
    body: JSON.stringify({
      amount, currency: "INR", receipt: `ws_${id.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40),
      notes: { workspace_id: id, user_id: user.id, plan: "pro" },
    }),
  }).catch((e) => { console.error("[billing] order request failed", e); return null; });
  const data: any = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || !data.id) {
    console.error("[billing] order failed", res?.status, JSON.stringify(data).slice(0, 300));
    return c.json({ error: "Couldn't start the payment. Please try again." }, 502);
  }
  await getDb().insert(payments).values({ workspaceId: id, userId: user.id, orderId: data.id, amount, currency: "INR" });
  return c.json({
    keyId: env.razorpayKeyId, orderId: data.id, amount, currency: "INR",
    name: "CRUD.chat", description: `Pro · ${env.proDays} days · up to ${env.proMembers} people`,
    prefill: { name: user.name || "", email: user.email || "", contact: user.phone || "" },
  });
});

billing.post("/workspaces/:id/billing/verify", async (c) => {
  const user = c.get("user"), id = c.req.param("id")!;
  if (!(await getMembership(user.id, id))) return c.json({ error: "Workspace not found." }, 404);
  const b = await body(c);
  const orderId = String(b.razorpay_order_id || ""), paymentId = String(b.razorpay_payment_id || ""), sig = String(b.razorpay_signature || "");
  if (!orderId || !paymentId || !sig || !env.razorpayKeySecret) return c.json({ error: "Payment details missing." }, 400);
  if (!sameHex(hmacHex(env.razorpayKeySecret, `${orderId}|${paymentId}`), sig)) {
    console.warn("[billing] bad payment signature", orderId);
    return c.json({ error: "We couldn't verify that payment. If money was taken, it will be confirmed shortly." }, 400);
  }
  const out = await activatePayment(orderId, paymentId);
  if (!out.ok || out.workspaceId !== id) return c.json({ error: "That payment isn't for this workspace." }, 400);
  publish(id, { type: "change", by: c.get("clientId") });
  console.log("[billing] pro activated", JSON.stringify({ workspace: id, orderId, paymentId, via: "checkout", already: out.already }));
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
  if (ev.event === "payment.captured" || ev.event === "order.paid") {
    const pay = ev.payload?.payment?.entity, order = ev.payload?.order?.entity;
    const orderId = pay?.order_id || order?.id, paymentId = pay?.id || "";
    if (orderId) {
      const out = await activatePayment(orderId, paymentId);
      if (out.ok) { publish(out.workspaceId, { type: "change", by: "razorpay" }); console.log("[billing] pro activated", JSON.stringify({ orderId, paymentId, via: ev.event, already: out.already })); }
      else console.warn("[billing] webhook for unknown order", orderId);
    }
  }
  return c.json({ ok: true });
});
