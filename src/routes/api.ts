import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { members, messages, records, sections, users, workspaces, type Fields } from "../db/schema.js";
import { env } from "../env.js";
import { normalizePhone } from "../lib/phone.js";
import { OtpError, requestOtp, verifyOtp } from "../auth/otp.js";
import { OtpSendError } from "../auth/interakt.js";
import { createSession, destroySession, requireUser, type AppEnv } from "../auth/session.js";
import { aiEnabled, planImport } from "../ai/claude.js";
import { createWorkspace, getMembership, listWorkspaces, loadState, nextColor } from "../domain/state.js";
import { processMessage, type ImageInput } from "../domain/messages.js";
import { applyImport, fallbackPlan, type Sheet } from "../domain/import.js";
import { cleanKey, esc } from "../domain/helpers.js";
import { publish, subscribe } from "../realtime.js";

export const api = new Hono<AppEnv>();

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const bigBody = bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: "That's too large to send." }, 413) });

// ---------- public ----------

api.get("/health", (c) => c.json({ ok: true }));
api.get("/config", (c) => c.json({ otpDevMode: env.otpDevMode, aiEnabled: aiEnabled() }));

api.post("/auth/request-otp", async (c) => {
  const phone = normalizePhone((await body(c)).phone);
  if (!phone) return c.json({ error: "Enter a valid mobile number." }, 400);
  try {
    const { devCode } = await requestOtp(phone);
    return c.json({ ok: true, phone: phone.e164, ...(devCode ? { devCode } : {}) });
  } catch (e) {
    if (e instanceof OtpError) return c.json({ error: e.message }, e.status);
    if (e instanceof OtpSendError) return c.json({ error: e.message }, 502);
    throw e;
  }
});

api.post("/auth/verify-otp", async (c) => {
  const b = await body(c);
  const phone = normalizePhone(b.phone);
  if (!phone) return c.json({ error: "Enter a valid mobile number." }, 400);
  try {
    const user = await verifyOtp(phone, str(b.code, 10));
    await createSession(c, user.id);
    return c.json({ ok: true, user: { id: user.id, phone: user.phone, name: user.name } });
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
api.use("/bootstrap", requireUser);
api.use("/workspaces", requireUser);
api.use("/workspaces/*", requireUser);
api.use("/records/*", requireUser);

api.get("/me", (c) => c.json({ user: c.get("user") }));

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

/** Everything the app needs on open. A first-time user gets a workspace automatically. */
api.get("/bootstrap", async (c) => {
  const user = c.get("user");
  let list = await listWorkspaces(user.id);
  if (!list.length) {
    await createWorkspace(user, "My workspace");
    list = await listWorkspaces(user.id);
  }
  const wanted = c.req.query("workspace");
  const current = list.find((w) => w.id === wanted)?.id ?? list[0].id;
  return c.json({ user, workspaces: list, current, state: await loadState(current, user.id) });
});

api.post("/workspaces", async (c) => {
  const user = c.get("user");
  const id = await createWorkspace(user, str((await body(c)).name, 60) || "New workspace");
  return c.json({ workspaces: await listWorkspaces(user.id), current: id, state: await loadState(id, user.id) });
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
  const phone = normalizePhone(b.phone);
  const name = str(b.name, 40);
  if (!phone) return c.json({ error: "Enter a valid mobile number." }, 400);
  if (!name) return c.json({ error: "Enter their name." }, 400);
  const [exists] = await db.select({ id: members.id }).from(members)
    .where(and(eq(members.workspaceId, id), eq(members.phone, phone.e164))).limit(1);
  if (exists) return c.json({ error: "That number is already in this workspace." }, 409);
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone.e164)).limit(1);
  await db.insert(members).values({ workspaceId: id, userId: u?.id ?? null, phone: phone.e164, name, color: await nextColor(db, id) });
  changed(c, id);
  return c.json({ state: await stateOf(c, id) });
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

// ----- messages: the core flow -----

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

api.post("/workspaces/:id/messages", bigBody, async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), user = c.get("user"), id = c.req.param("id");
  const images: ImageInput[] = (Array.isArray(b.images) ? b.images : []).slice(0, 4)
    .filter((im: any) => im && typeof im.data === "string" && IMAGE_TYPES.has(im.mediaType) && im.data.length < 7_000_000)
    .map((im: any) => ({ data: im.data.replace(/^data:[^,]+,/, ""), mediaType: im.mediaType }));
  const thumbs: string[] = (Array.isArray(b.thumbs) ? b.thumbs : []).slice(0, 4)
    .filter((t: unknown) => typeof t === "string" && t.startsWith("data:image/") && t.length < 150_000);
  const text = str(b.text, 4000);
  if (!text && !images.length) return c.json({ error: "Type something or attach a screenshot." }, 400);

  const out = await processMessage(
    { workspaceId: id, userId: user.id, authorName: user.name || "Someone" },
    { text, images, thumbs, contextRecordId: str(b.contextRecordId, 64) || null, clientId: c.get("clientId") },
  );
  return c.json({ ...out, state: await stateOf(c, id) });
});

// ----- spreadsheet import -----

api.post("/workspaces/:id/import", bigBody, async (c) => {
  if (!(await access(c))) return notFound(c);
  const b = await body(c), user = c.get("user"), id = c.req.param("id"), db = getDb();
  const fileName = str(b.fileName, 120) || "spreadsheet";
  let total = 0;
  const sheets: Sheet[] = (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 20).map((s: any) => {
    const headers: string[] = (Array.isArray(s?.headers) ? s.headers : []).slice(0, 80).map((h: unknown) => String(h ?? "").slice(0, 80));
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
  if (aiEnabled()) {
    try {
      const existing = await db.select({ name: sections.name, kind: sections.kind }).from(sections).where(eq(sections.workspaceId, id));
      plan = await planImport({
        sheets: sheets.map((s) => ({
          sheet: s.name, headers: s.headers.slice(0, 40),
          sample: s.rows.slice(0, 20).map((r) => Object.fromEntries(Object.entries(r).slice(0, 40).map(([k, v]) => [k, v.slice(0, 60)]))),
        })),
        existing,
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
