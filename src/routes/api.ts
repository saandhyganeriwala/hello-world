import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { members, messages, records, sections, users, workspaces, type Fields } from "../db/schema.js";
import { env } from "../env.js";
import { isAdmin } from "./admin.js";
import { rzp } from "./billing.js";
import { deleteAccount } from "../domain/account.js";
import { FEEDBACK_MAX, saveFeedback } from "../domain/feedback.js";
import { invalidIdentityMessage, normalizeIdentity } from "../lib/identity.js";
import { OtpError, requestOtp, verifyOtp } from "../auth/otp.js";
import { OtpSendError } from "../auth/errors.js";
import { createSession, destroySession, requireUser, type AppEnv } from "../auth/session.js";
import { aiEnabled, planImport } from "../ai/claude.js";
import { createWorkspace, getMembership, listWorkspaces, loadState, newInviteCode, nextColor } from "../domain/state.js";
import { processMessage, type DocInput, type ImageInput } from "../domain/messages.js";
import { applyImport, fallbackPlan, type Sheet } from "../domain/import.js";
import { cleanKey, esc } from "../domain/helpers.js";
import { removeView, sanitizeView, upsertView } from "../domain/views.js";
import { assertCanAddMember, billingStatus, LimitError, linkUsageToMessage, proActions, recordUsage } from "../domain/billing.js";
import { transcribe, transcribeCostUsd, transcribeProvider, TranscribeError } from "../ai/transcribe.js";
import { publish, subscribe } from "../realtime.js";

export const api = new Hono<AppEnv>();

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bigBody = bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: "That's too large to send." }, 413) });

// ---------- public ----------

api.get("/health", (c) => c.json({ ok: true }));
api.get("/config", (c) => c.json({
  otpDevMode: env.otpDevMode, aiEnabled: aiEnabled(), loginMethod: env.loginMethod, transcribe: !!transcribeProvider(),
  plans: { freeActions: env.freeActions, freeMembers: env.freeMembers, proPriceInr: env.proPriceInr, proPriceUsd: env.proPriceUsd, proDays: env.proDays,
    proMembers: env.proMembers, proActions: proActions(), paymentsReady: env.paymentsReady, iapProductId: env.iapProductId },
}));

// The login box sends { identifier } — an email or a phone number, per LOGIN_METHOD.
const identifierOf = (b: Record<string, any>) => b.identifier ?? b.email ?? b.phone;

api.post("/auth/request-otp", async (c) => {
  const id = normalizeIdentity(identifierOf(await body(c)));
  if (!id) return c.json({ error: invalidIdentityMessage() }, 400);
  try {
    const { devCode } = await requestOtp(id);
    return c.json({ ok: true, sentTo: id.value, via: id.kind, ...(devCode ? { devCode } : {}) });
  } catch (e) {
    if (e instanceof OtpError) return c.json({ error: e.message }, e.status);
    if (e instanceof OtpSendError) return c.json({ error: e.message }, 502);
    throw e;
  }
});

api.post("/auth/verify-otp", async (c) => {
  const b = await body(c);
  const id = normalizeIdentity(identifierOf(b));
  if (!id) return c.json({ error: invalidIdentityMessage() }, 400);
  try {
    const user = await verifyOtp(id, str(b.code, 10));
    await createSession(c, user.id);
    return c.json({ ok: true, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } });
  } catch (e) {
    if (e instanceof OtpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

api.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// ---------- authenticated ----------

api.use("/me", requireUser);
api.use("/feedback", requireUser);
api.use("/exports", requireUser);
api.use("/bootstrap", requireUser);
api.use("/workspaces", requireUser);
api.use("/workspaces/*", requireUser);
api.use("/records/*", requireUser);
api.use("/invites/*", requireUser);

api.get("/me", (c) => c.json({ user: c.get("user") }));
// Delete my account (App Store / Play requirement). Body must confirm with { confirm: "DELETE" }.
api.delete("/me", async (c) => {
  const user = c.get("user");
  if (String((await body(c)).confirm || "") !== "DELETE") return c.json({ error: "Please confirm to delete your account." }, 400);
  const before = await getDb().select({ ws: members.workspaceId }).from(members).where(eq(members.userId, user.id));
  const out = await deleteAccount(user.id);
  for (const sub of out.subscriptionsToCancel) {
    if (env.paymentsReady) await rzp("POST", `/subscriptions/${encodeURIComponent(sub)}/cancel`, { cancel_at_cycle_end: 0 }).catch(() => null);
  }
  before.forEach((m) => publish(m.ws, { type: "change", by: "account-deleted" }));
  await destroySession(c);
  console.log("[account] deleted", JSON.stringify({ user: user.id, deletedWorkspaces: out.deletedWorkspaces.length, handedOver: out.handedOver.length, cancelled: out.subscriptionsToCancel.length }));
  return c.json({ ok: true, ...out });
});


api.patch("/me", async (c) => {
  const user = c.get("user");
  const name = str((await body(c)).name, 40);
  if (!name) return c.json({ error: "Enter your name." }, 400);
  const db = getDb();
  await db.update(users).set({ name }).where(eq(users.id, user.id));
  const mine = await db.update(members).set({ name }).where(eq(members.userId, user.id)).returning({ ws: members.workspaceId });
  mine.forEach((m) => publish(m.ws, { type: "change", by: c.get("clientId") }));
  return c.json({ user: { ...user, name } });
});

/** Everything the app needs on open. Someone with no workspace yet chooses: start one, or join their team. */
api.get("/bootstrap", async (c) => {
  const user = c.get("user");
  const list = await listWorkspaces(user.id);
  const admin = isAdmin(user.email);
  if (!list.length) return c.json({ user, admin, workspaces: [], current: null, state: null });
  const wanted = c.req.query("workspace");
  const current = list.find((w) => w.id === wanted)?.id ?? list[0].id;
  return c.json({ user, admin, workspaces: list, current, state: await loadState(current, user.id) });
});

api.post("/workspaces", async (c) => {
  const user = c.get("user");
  const id = await createWorkspace(user, str((await body(c)).name, 60) || "New workspace");
  return c.json({ workspaces: await listWorkspaces(user.id), current: id, state: await loadState(id, user.id) });
});

// ----- invite links: /app/join/<code> -----

const normCode = (v: string | undefined) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
async function workspaceByCode(code: string) {
  if (code.length < 6) return null;
  const [w] = await getDb().select().from(workspaces).where(eq(workspaces.inviteCode, code)).limit(1);
  return w ?? null;
}

/** What the invite is for, so the person can confirm before joining. */
api.get("/invites/:code", async (c) => {
  const w = await workspaceByCode(normCode(c.req.param("code")));
  if (!w) return c.json({ error: "That invite link isn't valid any more. Ask your teammate for a new one." }, 404);
  const db = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.workspaceId, w.id));
  const [owner] = await db.select({ name: members.name }).from(members).where(and(eq(members.workspaceId, w.id), eq(members.role, "owner"))).limit(1);
  const already = !!(await getMembership(c.get("user").id, w.id));
  return c.json({ workspace: { id: w.id, name: w.name }, members: n, owner: owner?.name ?? null, already });
});

api.post("/invites/:code/join", async (c) => {
  const user = c.get("user");
  const w = await workspaceByCode(normCode(c.req.param("code")));
  if (!w) return c.json({ error: "That invite link isn't valid any more. Ask your teammate for a new one." }, 404);
  const db = getDb();
  if (!(await getMembership(user.id, w.id))) {
    // If they were already invited by email/number, claim that row instead of adding a second one.
    const mine = [user.email ? eq(members.email, user.email) : undefined, user.phone ? eq(members.phone, user.phone) : undefined].filter(Boolean) as any[];
    const [invited] = mine.length
      ? await db.select({ id: members.id }).from(members).where(and(eq(members.workspaceId, w.id), isNull(members.userId), or(...mine))).limit(1)
      : [];
    if (!invited) {
      try { await assertCanAddMember(w.id); }
      catch (e) {
        if (!(e instanceof LimitError)) throw e;
        const bs = await billingStatus(w.id);
        return c.json({ error: bs.plan === "pro"
          ? `${w.name} is full: a Pro workspace can have up to ${bs.memberLimit} people.`
          : `${w.name} is full: the free plan allows ${bs.memberLimit} people. Ask its owner to upgrade this workspace to Pro.`, limit: true }, 402);
      }
    }
    if (invited) await db.update(members).set({ userId: user.id, name: user.name }).where(eq(members.id, invited.id));
    else await db.insert(members).values({
      workspaceId: w.id, userId: user.id, email: user.email, phone: user.phone, name: user.name, role: "member", color: await nextColor(db, w.id),
    }).onConflictDoNothing();
    publish(w.id, { type: "change", by: c.get("clientId") });
  }
  return c.json({ workspaces: await listWorkspaces(user.id), current: w.id, state: await loadState(w.id, user.id) });
});

/** Loads the membership for :id or returns null after sending a 404. */
async function access(c: Context<AppEnv>) {
  const m = await getMembership(c.get("user").id, c.req.param("id")!);
  return m;
}
const notFound = (c: Context) => c.json({ error: "Workspace not found." }, 404);
const stateOf = async (c: Context<AppEnv>, wsId: string) => loadState(wsId, c.get("user").id);
const changed = (c: Context<AppEnv>, wsId: string) => publish(wsId, { type: "change", by: c.get("clientId") });

api.get("/workspaces/:id/state", async (c) => {
  if (!(await access(c))) return notFound(c);
  return c.json({ state: await stateOf(c, c.req.param("id")) });
});

api.patch("/workspaces/:id", async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c);
  const patch: Partial<typeof workspaces.$inferInsert> = {};
  if (str(b.name, 60)) patch.name = str(b.name, 60);
  if (Object.keys(patch).length) await getDb().update(workspaces).set(patch).where(eq(workspaces.id, c.req.param("id")));
  changed(c, c.req.param("id"));
  return c.json({ workspaces: await listWorkspaces(c.get("user").id), state: await stateOf(c, c.req.param("id")) });
});

api.post("/workspaces/:id/clear", async (c) => {
  const m = await access(c);
  if (!m) return notFound(c);
  if (m.role !== "owner") return c.json({ error: "Only the workspace owner can clear it." }, 403);
  const db = getDb(), id = c.req.param("id");
  await db.transaction(async (tx) => {
    await tx.delete(sections).where(eq(sections.workspaceId, id)); // records cascade
    await tx.delete(messages).where(eq(messages.workspaceId, id));
  });
  changed(c, id);
  return c.json({ state: await stateOf(c, id) });
});

// ----- team -----

api.post("/workspaces/:id/members", async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), id = c.req.param("id"), db = getDb();
  const who = normalizeIdentity(b.contact ?? b.email ?? b.phone);
  const name = str(b.name, 40);
  if (!name) return c.json({ error: "Enter their name." }, 400);
  if (!who) return c.json({ error: invalidIdentityMessage() }, 400);
  const memberCol = who.kind === "email" ? members.email : members.phone;
  const userCol = who.kind === "email" ? users.email : users.phone;
  const [exists] = await db.select({ id: members.id }).from(members)
    .where(and(eq(members.workspaceId, id), eq(memberCol, who.value))).limit(1);
  if (exists) return c.json({ error: `That ${who.kind === "email" ? "email" : "number"} is already in this workspace.` }, 409);
  try { await assertCanAddMember(id); } catch (e) { if (e instanceof LimitError) return c.json({ error: e.message, limit: true }, 402); throw e; }
  const [u] = await db.select({ id: users.id }).from(users).where(eq(userCol, who.value)).limit(1);
  await db.insert(members).values({
    workspaceId: id, userId: u?.id ?? null, name, color: await nextColor(db, id),
    ...(who.kind === "email" ? { email: who.value } : { phone: who.value }),
  });
  changed(c, id);
  return c.json({ state: await stateOf(c, id) });
});

api.post("/workspaces/:id/invite/reset", async (c) => {
  const m = await access(c);
  if (!m) return notFound(c);
  if (m.role !== "owner") return c.json({ error: "Only the owner can reset the invite link." }, 403);
  await getDb().update(workspaces).set({ inviteCode: newInviteCode() }).where(eq(workspaces.id, c.req.param("id")));
  return c.json({ state: await stateOf(c, c.req.param("id")) });
});

api.delete("/workspaces/:id/members/:memberId", async (c) => {
  const m = await access(c);
  if (!m) return notFound(c);
  if (m.role !== "owner") return c.json({ error: "Only the owner can remove people." }, 403);
  if (c.req.param("memberId") === m.id) return c.json({ error: "You can't remove yourself." }, 400);
  await getDb().delete(members).where(and(eq(members.id, c.req.param("memberId")), eq(members.workspaceId, c.req.param("id"))));
  changed(c, c.req.param("id"));
  return c.json({ state: await stateOf(c, c.req.param("id")) });
});

// ----- feedback (Menu → Send feedback; admins read it on /admin) -----

api.post("/feedback", async (c) => {
  const b = await body(c), user = c.get("user");
  const text = str(b.text, FEEDBACK_MAX);
  if (text.length < 2) return c.json({ error: "Write a few words first." }, 400);
  let workspaceId: string | null = str(b.workspaceId, 64) || null;
  if (workspaceId && !(await getMembership(user.id, workspaceId).catch(() => null))) workspaceId = null;
  await saveFeedback({ userId: user.id, workspaceId, text, page: str(b.page, 120), userAgent: c.req.header("user-agent") || "" });
  return c.json({ ok: true });
});

// ----- export downloads -----
// App builds that can't save files themselves upload the export here, and the page opens /api/dl/<token>/<name>
// in Safari, which downloads it to Files → Downloads. Links are random, last 30 minutes and live in memory only.
const DL_TTL = 30 * 60_000, DL_MAX_BYTES = 20 * 1024 * 1024;
const downloads = new Map<string, { name: string; mime: string; data: Buffer; exp: number }>();
const DL_TYPES = new Set(["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
function sweepDownloads() { const now = Date.now(); for (const [k, v] of downloads) if (v.exp < now) downloads.delete(k); }

api.post("/exports", bigBody, async (c) => {
  sweepDownloads();
  const b = await body(c);
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10);
  const out: { name: string; url: string }[] = [];
  let total = 0;
  for (const f of files) {
    const name = str(f?.name, 120).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "Export.csv";
    const mime = DL_TYPES.has(f?.mime) ? f.mime : name.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv";
    const data = Buffer.from(typeof f?.data === "string" ? f.data : "", "base64");
    total += data.length;
    if (!data.length || total > DL_MAX_BYTES) return c.json({ error: "That export is too large. Try fewer views." }, 413);
    const token = crypto.randomBytes(18).toString("base64url");
    downloads.set(token, { name, mime, data, exp: Date.now() + DL_TTL });
    out.push({ name, url: `/api/dl/${token}/${encodeURIComponent(name)}` });
  }
  if (!out.length) return c.json({ error: "Nothing to export." }, 400);
  return c.json({ files: out });
});

api.get("/dl/:token/:name?", (c) => {
  const d = downloads.get(c.req.param("token"));
  if (!d || d.exp < Date.now()) return c.text("This download link has expired. Export again from CRUD.chat.", 404);
  const ascii = d.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return c.body(new Uint8Array(d.data), 200, {
    "content-type": d.mime + (d.mime === "text/csv" ? "; charset=utf-8" : ""),
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    "cache-control": "private, no-store",
  });
});

// ----- messages: the core flow -----

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

api.post("/workspaces/:id/messages", bigBody, async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), user = c.get("user"), id = c.req.param("id");
  const images: ImageInput[] = (Array.isArray(b.images) ? b.images : []).slice(0, 4)
    .filter((im: any) => im && typeof im.data === "string" && IMAGE_TYPES.has(im.mediaType) && im.data.length < 7_000_000)
    .map((im: any) => ({ data: im.data.replace(/^data:[^,]+,/, ""), mediaType: im.mediaType }));
  // Shared files: PDFs up to ~10 MB, and plain text (a WhatsApp chat export, a .txt) up to 150,000 characters.
  const docs: DocInput[] = (Array.isArray(b.docs) ? b.docs : []).slice(0, 3)
    .filter((d: any) => d && typeof d.data === "string" && d.data.length > 0 &&
      ((d.mediaType === "application/pdf" && d.data.length < 14_000_000) || (d.mediaType === "text/plain" && d.data.length <= 150_000)))
    .map((d: any) => ({ name: str(d.name, 120) || (d.mediaType === "application/pdf" ? "Document.pdf" : "Text"), mediaType: d.mediaType,
      data: d.mediaType === "application/pdf" ? d.data.replace(/^data:[^,]+,/, "") : d.data }));
  const thumbs: string[] = (Array.isArray(b.thumbs) ? b.thumbs : []).slice(0, 6)
    .filter((t: unknown) => typeof t === "string" && /^data:image\/(jpeg|png|webp|gif);/.test(t) && t.length < 150_000);
  const text = str(b.text, 4000);
  if (!text && !images.length && !docs.length) return c.json({ error: "Type something or attach a screenshot." }, 400);

  const out = await processMessage(
    { workspaceId: id, userId: user.id, authorName: user.name || "Someone" },
    {
      text, images, docs, thumbs, contextRecordId: str(b.contextRecordId, 64) || null, clientId: c.get("clientId"),
      viewing: b.viewing && typeof b.viewing.section === "string"
        ? { section: str(b.viewing.section, 80), view: sanitizeView(b.viewing.view) } : null,
    },
  );
  // A voice note's transcription happened before this message existed: link it now.
  if (out.messageId && Array.isArray(b.voiceUsageIds) && b.voiceUsageIds.length)
    await linkUsageToMessage(id, user.id, b.voiceUsageIds.map(String), out.messageId).catch(() => {});
  return c.json({ ...out, state: await stateOf(c, id) });
});

// ----- views (from the Customize menu) -----

api.post("/workspaces/:id/views", async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), id = c.req.param("id"), db = getDb();
  const [s] = await db.select().from(sections)
    .where(and(eq(sections.workspaceId, id), sql`lower(${sections.name}) = lower(${str(b.section, 80)})`)).limit(1);
  if (!s) return c.json({ error: "Section not found." }, 404);
  let views;
  if (b.remove) views = removeView(s.views, str(b.remove, 40));
  else { const v = sanitizeView(b.view); if (!v) return c.json({ error: "Nothing to save." }, 400); views = upsertView(s.views, v); }
  await db.update(sections).set({ views }).where(eq(sections.id, s.id));
  changed(c, id);
  return c.json({ state: await stateOf(c, id) });
});

// ----- voice notes → text -----
// Raw audio in the body (content-type = the recording's type), x-duration-ms = its length.
api.post("/workspaces/:id/transcribe", bodyLimit({ maxSize: 12 * 1024 * 1024, onError: (c) => c.json({ error: "That recording is too long." }, 413) }), async (c) => {
  if (!(await access(c))) return notFound(c);
  const id = c.req.param("id"), user = c.get("user");
  if (!transcribeProvider()) return c.json({ error: "Voice transcription isn't set up." }, 503);
  const bill = await billingStatus(id);
  if (!bill.ok) return c.json({ error: bill.plan === "pro" ? "This month's AI allowance is used up." : "Your free AI actions are used up.", limit: true }, 402);
  const audio = Buffer.from(await c.req.arrayBuffer());
  if (audio.length < 800) return c.json({ text: "" });
  const seconds = Math.min(600, Math.max(1, Number(c.req.header("x-duration-ms") || 0) / 1000 || audio.length / 4000));
  // Names and products from this workspace help the model spell them right (OpenAI uses it as a prompt).
  const recs = await getDb().select({ fields: records.fields }).from(records).where(eq(records.workspaceId, id)).limit(300);
  const words = new Set<string>();
  for (const r of recs) for (const k of ["Title", "Customer", "Name", "Product", "Item", "Supplier"]) { const v = r.fields?.[k]; if (v && v.length < 40) words.add(v); }
  const mem = await getDb().select({ name: members.name }).from(members).where(eq(members.workspaceId, id));
  mem.forEach((m) => m.name && words.add(m.name));
  const prompt = words.size ? `A short business voice note, often Indian English or Hinglish. Names and items that may come up: ${[...words].slice(0, 80).join(", ")}.` : "A short business voice note, often Indian English or Hinglish.";
  try {
    const out = await transcribe(audio, c.req.header("content-type") || "audio/webm", { prompt });
    const usageId = await recordUsage(id, user.id, { label: "transcribe", model: out.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      transcribeCostUsd(out.provider, out.model, seconds), { source: `Voice note · ${Math.round(seconds)}s` });
    console.log(JSON.stringify({ voice: out.provider, model: out.model, seconds: Math.round(seconds), chars: out.text.length }));
    return c.json({ text: out.text, usageId });
  } catch (e) {
    if (e instanceof TranscribeError) return c.json({ error: "Sorry — I couldn't make out that voice note. Please try again." }, 502);
    throw e;
  }
});

// ----- spreadsheet import -----

api.post("/workspaces/:id/import", bigBody, async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), user = c.get("user"), id = c.req.param("id"), db = getDb();
  const fileName = str(b.fileName, 120) || "spreadsheet";
  let total = 0;
  const sheets: Sheet[] = (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 20).map((s: any) => {
    const headers: string[] = (Array.isArray(s?.headers) ? s.headers : []).slice(0, 150).map((h: unknown) => String(h ?? "").slice(0, 80));
    const rows = (Array.isArray(s?.rows) ? s.rows : []).slice(0, Math.max(0, 10_000 - total)).map((r: any) => {
      const o: Record<string, string> = {};
      for (const h of headers) if (r && r[h] != null && String(r[h]).trim() !== "") o[h] = String(r[h]).slice(0, 1000);
      return o;
    }).filter((o: object) => Object.keys(o).length);
    total += rows.length;
    return { name: String(s?.name ?? "Sheet").slice(0, 80), headers, rows };
  }).filter((s: Sheet) => s.rows.length);
  if (!sheets.length) return c.json({ error: "That file had no rows I could read." }, 400);

  const [msg] = await db.insert(messages).values({
    workspaceId: id, userId: user.id, authorName: user.name || "Someone", text: `Imported ${fileName}`, pending: true,
  }).returning();
  changed(c, id);

  let plan = null;
  if (aiEnabled() && (await billingStatus(id)).ok) {
    try {
      const existing = await db.select({ name: sections.name, kind: sections.kind }).from(sections).where(eq(sections.workspaceId, id));
      plan = await planImport({
        sheets: sheets.map((s) => ({
          sheet: s.name, headers: s.headers,
          // Every column with how often it's filled and a few real values from anywhere in the file, so a column
          // that's empty in the first rows isn't mistaken for an empty one.
          columns: s.headers.map((h) => {
            const vals = s.rows.map((r) => r[h]).filter((v) => v != null && String(v).trim() !== "");
            return { header: h, filled: vals.length, of: s.rows.length, examples: [...new Set(vals.map((v) => String(v).slice(0, 50)))].slice(0, 3) };
          }),
          sample: s.rows.slice(0, 8).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.slice(0, 40)]))),
        })),
        existing,
        onUsage: (u) => recordUsage(id, user.id, u, undefined, { messageId: msg.id,
          source: `Import: ${fileName} (${sheets.length} sheet${sheets.length > 1 ? "s" : ""}, ${sheets.reduce((n, s) => n + s.rows.length, 0)} rows)` }),
      });
    } catch (e) { console.error("[ai] import plan failed", e); }
  }
  if (!plan?.sheets?.length) plan = fallbackPlan(sheets);

  const ctx = { workspaceId: id, userId: user.id, authorName: user.name || "Someone" };
  const res = await db.transaction((tx) => applyImport(tx, ctx, sheets, plan!));
  const tag = res.count
    ? `Imported ${res.count} record${res.count > 1 ? "s" : ""}${res.sections.length > 1 ? ` · ${res.sections.length} tabs` : ` → ${res.sections[0]}`}`
    : "Nothing to import";
  await db.update(messages).set({ pending: false, tag, tagIcon: "layers" }).where(eq(messages.id, msg.id));
  if (res.count) {
    await db.insert(messages).values({
      workspaceId: id, role: "assistant", authorName: "CRUD",
      text: `Imported ${res.count} record${res.count > 1 ? "s" : ""} from ${fileName} into ${res.sections.map((s) => `“${s}”`).join(", ")}.` +
        (res.capped ? " I stopped at 2,000 rows — split the file to bring in the rest." : ""),
    });
  }
  changed(c, id);
  return c.json({ result: { count: res.count, sections: res.sections, newSections: res.newSections, touched: res.touched }, state: await stateOf(c, id) });
});

// ----- live updates -----

api.get("/workspaces/:id/events", async (c) => {
  if (!(await access(c))) return notFound(c);
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsub = subscribe(id, (ev) => { stream.writeSSE({ event: "change", data: JSON.stringify(ev) }).catch(() => {}); });
    stream.onAbort(() => { open = false; unsub(); });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (open) {
      await stream.sleep(25_000);
      if (open) await stream.writeSSE({ event: "ping", data: "" }).catch(() => { open = false; });
    }
    unsub();
  });
});

// ----- direct record edits (tap a field, tick a task, delete) -----

async function recordAccess(c: Context<AppEnv>) {
  const [r] = await getDb().select().from(records).where(eq(records.id, c.req.param("id")!)).limit(1);
  if (!r || !(await getMembership(c.get("user").id, r.workspaceId))) return null;
  return r;
}

api.patch("/records/:id", async (c) => {
  const r = await recordAccess(c);
  if (!r) return c.json({ error: "Record not found." }, 404);
  const b = await body(c), user = c.get("user");
  if (!b.fields || typeof b.fields !== "object" || Array.isArray(b.fields)) return c.json({ error: "Nothing to save." }, 400);
  const fields: Fields = {};
  for (const [k, v] of Object.entries(b.fields).slice(0, 80)) {
    const val = v == null ? "" : String(v).trim().slice(0, 2000);
    if (val) fields[cleanKey(k)] = val;
  }
  const change = str(b.change, 80) || "edited this";
  const author = user.name || "Someone";
  const history = [...(r.history ?? []), { ts: Date.now(), author, type: "edit" as const, html: `<b>${esc(author)}</b> ${esc(change)}` }];
  await getDb().update(records).set({ fields, history, updatedAt: new Date() }).where(eq(records.id, r.id));
  changed(c, r.workspaceId);
  return c.json({ state: await stateOf(c, r.workspaceId) });
});

api.delete("/records/:id", async (c) => {
  const r = await recordAccess(c);
  if (!r) return c.json({ error: "Record not found." }, 404);
  await getDb().delete(records).where(eq(records.id, r.id));
  changed(c, r.workspaceId);
  return c.json({ state: await stateOf(c, r.workspaceId) });
});
