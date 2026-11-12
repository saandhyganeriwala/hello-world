// In-app purchases: Pro bought through the App Store or Google Play.
//
// The phone buys the subscription (StoreKit 2 / Play Billing — see mobile/), tagged with the workspace id
// (Apple: appAccountToken, Google: obfuscatedAccountId). It sends us the result; we check it with Apple / Google
// and feed it into the same subscription records Razorpay uses (applyCharge / setSubscriptionStatus), so a
// workspace is Pro no matter where it was paid for. Renewals, cancellations, refunds and billing problems
// arrive later as server notifications (App Store Server Notifications V2 / Play real-time developer
// notifications) and go through the same code. Every charge is counted once per transaction / order id.
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { Environment, NotificationTypeV2, SignedDataVerifier, Subtype, VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { getDb } from "../db/client.js";
import { subscriptions } from "../db/schema.js";
import { env } from "../env.js";
import { applyCharge, setSubscriptionStatus } from "./billing.js";

export class IapError extends Error { constructor(message: string, public status: 400 | 403 | 502 = 400) { super(message); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const proPricePaise = () => Math.round(env.proPriceInr * 100);

async function subRow(subscriptionId: string) {
  const [row] = await getDb().select().from(subscriptions).where(eq(subscriptions.subscriptionId, subscriptionId)).limit(1);
  return row ?? null;
}
async function ensureRow(v: { subscriptionId: string; provider: "apple" | "google"; workspaceId: string; userId: string | null; environment?: string | null; amount: number; currency: string }) {
  await getDb().insert(subscriptions).values({ workspaceId: v.workspaceId, userId: v.userId, subscriptionId: v.subscriptionId, provider: v.provider,
    environment: v.environment ?? null, planId: env.iapProductId, amount: v.amount, currency: v.currency, status: "created" }).onConflictDoNothing();
}

// ======================================================================================================
// App Store
// ======================================================================================================

export type AppleTx = {
  originalTransactionId: string; transactionId: string; productId: string; bundleId: string;
  purchaseDate?: number; expiresDate?: number; revocationDate?: number; appAccountToken?: string;
  environment?: string; price?: number; currency?: string;
};

let appleRoots: Promise<Buffer[]> | null = null;
/** Apple's root certificate, fetched once over HTTPS from apple.com (StoreKit signatures chain up to it). */
function rootCerts() {
  appleRoots ??= fetch("https://www.apple.com/certificateauthority/AppleRootCA-G3.cer")
    .then(async (r) => { if (!r.ok) throw new Error(`Apple root certificate: HTTP ${r.status}`); return [Buffer.from(await r.arrayBuffer())]; })
    .catch((e) => { appleRoots = null; throw e; });
  return appleRoots;
}
const verifiers = new Map<Environment, SignedDataVerifier>();
async function verifierFor(e: Environment) {
  if (!verifiers.has(e)) {
    if (e === Environment.PRODUCTION && !env.appleAppId) throw new IapError("App Store purchases aren't set up yet (APPLE_APP_ID).", 502);
    verifiers.set(e, new SignedDataVerifier(await rootCerts(), true, e, env.appleBundleId, e === Environment.PRODUCTION ? env.appleAppId : undefined));
  }
  return verifiers.get(e)!;
}
const b64json = (jws: string) => JSON.parse(Buffer.from(jws.split(".")[1] || "", "base64url").toString("utf8"));

/** Verifies an App Store JWS (transaction or notification). Production first, then Sandbox (TestFlight and App Review buy in Sandbox). */
async function verifyApple<T>(jws: string, kind: "transaction" | "notification"): Promise<T> {
  if (env.iapFakeApple) return b64json(jws) as T; // local tests only
  let last: unknown;
  for (const e of [Environment.PRODUCTION, Environment.SANDBOX]) {
    try {
      const v = await verifierFor(e);
      return (kind === "transaction" ? await v.verifyAndDecodeTransaction(jws) : await v.verifyAndDecodeNotification(jws)) as T;
    } catch (err) {
      last = err;
      if (err instanceof VerificationException && err.status === VerificationStatus.INVALID_ENVIRONMENT) continue;
      if (err instanceof IapError && e === Environment.PRODUCTION) continue; // no APPLE_APP_ID yet: Sandbox still works
      break;
    }
  }
  console.warn("[iap] apple verification failed", (last as any)?.status ?? (last as any)?.message);
  throw new IapError("We couldn't verify that App Store purchase.");
}

export async function decodeAppleTransaction(jws: string) {
  const t = await verifyApple<AppleTx>(jws, "transaction");
  if (t.bundleId !== env.appleBundleId) throw new IapError("That purchase is for a different app.");
  if (t.productId !== env.iapProductId) throw new IapError("That isn't the CRUD.chat Pro subscription.");
  return t;
}

/** The workspace an App Store transaction belongs to (the appAccountToken we set, or a subscription we already know). */
export async function appleWorkspace(t: AppleTx) {
  const known = await subRow(`apple:${t.originalTransactionId}`);
  if (known) return known.workspaceId;
  return t.appAccountToken && UUID.test(t.appAccountToken) ? t.appAccountToken.toLowerCase() : null;
}

/** A verified App Store transaction: record the subscription and, if it's current, give Pro for its period. */
export async function applyAppleTransaction(t: AppleTx, userId: string | null, workspaceId: string) {
  const id = `apple:${t.originalTransactionId}`;
  const amount = typeof t.price === "number" && t.price > 0 ? Math.round(t.price / 10) : proPricePaise(); // milli-units → paise
  await ensureRow({ subscriptionId: id, provider: "apple", workspaceId, userId, environment: t.environment ?? null, amount, currency: t.currency || "INR" });
  if (t.revocationDate) { await setSubscriptionStatus(id, "halted", { force: true }); return { ok: true as const, workspaceId, active: false }; }
  const end = t.expiresDate ? new Date(t.expiresDate) : null;
  if (!end || end.getTime() <= Date.now()) return { ok: true as const, workspaceId, active: false };
  const out = await applyCharge({ subscriptionId: id, paymentId: `apple:${t.transactionId}`, amount, currency: t.currency || "INR",
    periodStart: t.purchaseDate ? new Date(t.purchaseDate) : null, periodEnd: end });
  return { ok: out.ok, workspaceId, active: true };
}

/** App Store Server Notifications V2 (renewals, auto-renew on/off, billing retry, expiry, refunds). */
export async function handleAppleNotification(signedPayload: string) {
  const n = await verifyApple<any>(signedPayload, "notification");
  const type: string = n.notificationType, subtype: string | undefined = n.subtype;
  if (type === NotificationTypeV2.TEST || !n.data?.signedTransactionInfo) return { type, workspaceId: null as string | null };
  const t = await decodeAppleTransaction(n.data.signedTransactionInfo);
  const renewal = n.data.signedRenewalInfo ? await verifyApple<any>(n.data.signedRenewalInfo, "transaction").catch(() => null) : null;
  const ws = await appleWorkspace(t);
  if (!ws) { console.warn("[iap] apple notification for an unknown subscription", t.originalTransactionId, type); return { type, workspaceId: null }; }
  const id = `apple:${t.originalTransactionId}`;
  switch (type) {
    case NotificationTypeV2.SUBSCRIBED: case NotificationTypeV2.DID_RENEW: case NotificationTypeV2.OFFER_REDEEMED:
    case NotificationTypeV2.RENEWAL_EXTENDED: case NotificationTypeV2.REFUND_REVERSED:
      await applyAppleTransaction(t, null, ws);
      await setSubscriptionStatus(id, renewal && renewal.autoRenewStatus === 0 ? "cancelling" : "active", { force: true });
      break;
    case NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS:
      await applyAppleTransaction(t, null, ws);
      await setSubscriptionStatus(id, subtype === Subtype.AUTO_RENEW_DISABLED ? "cancelling" : "active", { force: true });
      break;
    case NotificationTypeV2.DID_FAIL_TO_RENEW:
      await setSubscriptionStatus(id, "pending", { force: true }); // Apple retries; Pro carries on through the grace days
      break;
    case NotificationTypeV2.EXPIRED: case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
      await setSubscriptionStatus(id, "cancelled", { force: true });
      break;
    case NotificationTypeV2.REFUND: case NotificationTypeV2.REVOKE:
      await setSubscriptionStatus(id, "halted", { force: true });
      break;
  }
  return { type, workspaceId: ws };
}

// ======================================================================================================
// Google Play
// ======================================================================================================

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
let gToken: { value: string; exp: number } | null = null;

/** OAuth access token for the Play Developer API, from the service account key (signed JWT → token). */
async function googleAccessToken() {
  if (gToken && gToken.exp > Date.now() + 60_000) return gToken.value;
  if (!env.googlePlayServiceAccount) throw new IapError("Google Play purchases aren't set up yet (GOOGLE_PLAY_SERVICE_ACCOUNT).", 502);
  let sa: ServiceAccount;
  try { sa = JSON.parse(env.googlePlayServiceAccount); } catch { throw new IapError("GOOGLE_PLAY_SERVICE_ACCOUNT isn't valid JSON.", 502); }
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token", now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url")}`;
  const r = await fetch(tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !j.access_token) { console.error("[iap] google token failed", r?.status, JSON.stringify(j).slice(0, 200)); throw new IapError("Couldn't reach Google Play. Please try again.", 502); }
  gToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return gToken.value;
}
async function play(method: "GET" | "POST", path: string, body?: object) {
  const r = await fetch(`${env.googlePlayApiBase}/androidpublisher/v3/applications/${encodeURIComponent(env.googlePlayPackage)}/${path}`, {
    method, headers: { authorization: `Bearer ${await googleAccessToken()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!r?.ok, status: r?.status ?? 0, data: j };
}

export type GoogleSub = {
  subscriptionState?: string; latestOrderId?: string; startTime?: string; acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId: string; expiryTime?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean } }[];
};

/** Looks the purchase up with Google (purchases.subscriptionsv2.get). */
export async function fetchGoogleSubscription(purchaseToken: string): Promise<GoogleSub> {
  const r = await play("GET", `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  if (!r.ok) {
    console.warn("[iap] google lookup failed", r.status, JSON.stringify(r.data).slice(0, 200));
    throw new IapError(r.status === 404 || r.status === 400 ? "We couldn't find that Google Play purchase." : "Couldn't reach Google Play. Please try again.", r.status === 404 || r.status === 400 ? 400 : 502);
  }
  return r.data as GoogleSub;
}

export async function googleWorkspace(purchaseToken: string, s: GoogleSub) {
  const known = await subRow(`google:${purchaseToken}`);
  if (known) return known.workspaceId;
  const ws = s.externalAccountIdentifiers?.obfuscatedExternalAccountId || "";
  return UUID.test(ws) ? ws.toLowerCase() : null;
}

/** A Google Play subscription as Google reports it now: record it and bring Pro in line with its state. */
export async function applyGoogleSubscription(purchaseToken: string, s: GoogleSub, userId: string | null, workspaceId: string) {
  const line = s.lineItems?.find((l) => l.productId === env.iapProductId);
  if (!line) throw new IapError("That isn't the CRUD.chat Pro subscription.");
  const id = `google:${purchaseToken}`;
  await ensureRow({ subscriptionId: id, provider: "google", workspaceId, userId, amount: proPricePaise(), currency: "INR" });
  const end = line.expiryTime ? new Date(line.expiryTime) : null, current = !!end && end.getTime() > Date.now();
  const state = s.subscriptionState || "";
  const charge = async () => {
    if (current && s.latestOrderId) await applyCharge({ subscriptionId: id, paymentId: `google:${s.latestOrderId}`, amount: proPricePaise(), currency: "INR", periodEnd: end });
  };
  if (state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") {
    await charge();
    await setSubscriptionStatus(id, state.endsWith("GRACE_PERIOD") ? "pending" : line.autoRenewingPlan?.autoRenewEnabled === false ? "cancelling" : "active", { force: true });
    // Google refunds purchases that aren't acknowledged within 3 days.
    if (s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
      const ack = await play("POST", `purchases/subscriptions/${encodeURIComponent(line.productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
      if (!ack.ok) console.warn("[iap] google acknowledge failed", ack.status);
    }
  } else if (state === "SUBSCRIPTION_STATE_CANCELED") {
    await charge(); // still paid up until the period ends
    await setSubscriptionStatus(id, current ? "cancelling" : "cancelled", { force: true });
  } else if (state === "SUBSCRIPTION_STATE_ON_HOLD") {
    await setSubscriptionStatus(id, "halted", { force: true });
  } else if (state === "SUBSCRIPTION_STATE_PAUSED") {
    await setSubscriptionStatus(id, "paused", { force: true });
  } else if (state === "SUBSCRIPTION_STATE_EXPIRED") {
    await setSubscriptionStatus(id, "cancelled", { force: true });
  } // PENDING (payment not completed yet): nothing to do until Google tells us more
  return { ok: true as const, workspaceId, active: state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" || (state === "SUBSCRIPTION_STATE_CANCELED" && current) };
}

/** Play real-time developer notifications (Pub/Sub push). We re-read the subscription from Google each time. */
export async function handleGoogleNotification(body: any) {
  let msg: any = {};
  try { msg = JSON.parse(Buffer.from(String(body?.message?.data || ""), "base64").toString("utf8")); } catch { /* ignore */ }
  if (msg.packageName && msg.packageName !== env.googlePlayPackage) return { kind: "other-app", workspaceId: null as string | null };
  const voided = msg.voidedPurchaseNotification;
  if (voided?.purchaseToken) {
    const row = await subRow(`google:${voided.purchaseToken}`);
    if (row) await setSubscriptionStatus(row.subscriptionId, "halted", { force: true });
    return { kind: "voided", workspaceId: row?.workspaceId ?? null };
  }
  const token = msg.subscriptionNotification?.purchaseToken;
  if (!token) return { kind: msg.testNotification ? "test" : "ignored", workspaceId: null };
  const s = await fetchGoogleSubscription(token);
  const ws = await googleWorkspace(token, s);
  if (!ws) { console.warn("[iap] google notification for an unknown subscription"); return { kind: "unknown", workspaceId: null }; }
  await applyGoogleSubscription(token, s, null, ws);
  return { kind: "subscription", workspaceId: ws };
}
