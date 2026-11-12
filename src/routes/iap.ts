// In-app purchase endpoints (see src/domain/iap.ts).
//   POST /api/iap/apple                 → the app sends a StoreKit transaction (purchase or restore)
//   POST /api/iap/google                → the app sends a Play purchase token (purchase or restore)
//   POST /api/iap/apple/notifications   → App Store Server Notifications V2 (signed by Apple)
//   POST /api/iap/google/notifications  → Play real-time developer notifications via Pub/Sub push (?token=GOOGLE_RTDN_TOKEN)
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { requireUser, type AppEnv } from "../auth/session.js";
import { env } from "../env.js";
import { getMembership, loadState } from "../domain/state.js";
import { publish } from "../realtime.js";
import {
  IapError, appleWorkspace, applyAppleTransaction, applyGoogleSubscription, decodeAppleTransaction,
  fetchGoogleSubscription, googleWorkspace, handleAppleNotification, handleGoogleNotification,
} from "../domain/iap.js";

export const iap = new Hono<AppEnv>();
const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;
const fail = (c: Context, e: unknown) => {
  if (e instanceof IapError) return c.json({ error: e.message }, e.status);
  console.error("[iap]", e);
  return c.json({ error: "Something went wrong with that purchase. Please try again." }, 500);
};

iap.use("/iap/apple", requireUser);
iap.use("/iap/google", requireUser);

iap.post("/iap/apple", async (c) => {
  const user = c.get("user");
  try {
    const t = await decodeAppleTransaction(String((await body(c)).signedTransaction || ""));
    const ws = await appleWorkspace(t);
    if (!ws || !(await getMembership(user.id, ws))) throw new IapError("That purchase belongs to a workspace you're not in.", 403);
    const out = await applyAppleTransaction(t, user.id, ws);
    publish(ws, { type: "change", by: c.get("clientId") });
    console.log("[iap] apple", JSON.stringify({ workspace: ws, tx: t.transactionId, env: t.environment, active: out.active }));
    return c.json({ ok: true, active: out.active, workspaceId: ws, state: await loadState(ws, user.id) });
  } catch (e) { return fail(c, e); }
});

iap.post("/iap/google", async (c) => {
  const user = c.get("user");
  try {
    const token = String((await body(c)).purchaseToken || "");
    if (!token) throw new IapError("Purchase details missing.");
    const s = await fetchGoogleSubscription(token);
    const ws = await googleWorkspace(token, s);
    if (!ws || !(await getMembership(user.id, ws))) throw new IapError("That purchase belongs to a workspace you're not in.", 403);
    const out = await applyGoogleSubscription(token, s, user.id, ws);
    publish(ws, { type: "change", by: c.get("clientId") });
    console.log("[iap] google", JSON.stringify({ workspace: ws, state: s.subscriptionState, active: out.active }));
    return c.json({ ok: true, active: out.active, workspaceId: ws, state: await loadState(ws, user.id) });
  } catch (e) { return fail(c, e); }
});

iap.post("/iap/apple/notifications", async (c) => {
  const signed = String((await body(c)).signedPayload || "");
  if (!signed) return c.json({ error: "bad body" }, 400);
  try {
    const out = await handleAppleNotification(signed);
    if (out.workspaceId) publish(out.workspaceId, { type: "change", by: "app-store" });
    console.log("[iap] apple notification", JSON.stringify(out));
    return c.json({ ok: true });
  } catch (e) {
    // A bad signature is refused; anything else is answered with 500 so Apple retries later.
    if (e instanceof IapError && e.status === 400) return c.json({ error: e.message }, 400);
    console.error("[iap] apple notification failed", e);
    return c.json({ error: "retry" }, 500);
  }
});

iap.post("/iap/google/notifications", async (c) => {
  const given = Buffer.from(c.req.query("token") || ""), want = Buffer.from(env.googleRtdnToken);
  if (!env.googleRtdnToken || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return c.json({ error: "forbidden" }, 403);
  try {
    const out = await handleGoogleNotification(await body(c));
    if (out.workspaceId) publish(out.workspaceId, { type: "change", by: "google-play" });
    console.log("[iap] google notification", JSON.stringify(out));
    return c.json({ ok: true });
  } catch (e) {
    console.error("[iap] google notification failed", e);
    return c.json({ error: "retry" }, 500); // Pub/Sub redelivers
  }
});
