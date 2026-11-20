// Admin analytics + the visit beacon.
//   POST /api/t                → records a page visit (public, no cookies; bots ignored)
//   GET  /api/admin/stats      → dashboard numbers, for emails listed in ADMIN_EMAILS
//   GET  /api/admin/feedback   → feedback people sent from the app (PATCH /api/admin/feedback/:id {status})
//   POST /api/admin/lab        → run the model lab on chosen Claude models; GET /api/lab/:id → its report (shareable link)
import { Hono, type MiddlewareHandler } from "hono";
import { env } from "../env.js";
import { requireUser, type AppEnv } from "../auth/session.js";
import { adminStats, trackVisit, usageLookup } from "../domain/analytics.js";
import { listFeedback, setFeedbackStatus } from "../domain/feedback.js";
import { LAB_MODELS, labReport, startLab } from "../domain/modelLab.js";
import { resetAllowance } from "../domain/billing.js";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { aiEnabled } from "../ai/claude.js";

export const admin = new Hono<AppEnv>();

export const isAdmin = (email: string | null | undefined) => !!email && env.adminEmails.includes(email.toLowerCase());
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c.get("user").email)) return c.json({ error: "This page is for admins only." }, 403);
  await next();
};

admin.post("/t", async (c) => {
  let b: any = {};
  try { b = JSON.parse(await c.req.text()); } catch { /* sendBeacon sends text */ }
  const ip = (c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || (c.req.header("x-forwarded-for") || "").split(",")[0] || "").trim();
  await trackVisit({
    path: String(b.p || "/"), referrer: String(b.r || ""), utm: String(b.u || ""), ip, ua: c.req.header("user-agent") || "",
    country: c.req.header("cf-ipcountry") || c.req.header("x-vercel-ip-country") || "", host: c.req.header("host") || "",
  }).catch((e) => console.error("[track]", e?.message));
  return c.body(null, 204);
});

admin.use("/admin/*", requireUser, requireAdmin);
admin.get("/admin/stats", async (c) => {
  const days = Math.max(0, Math.min(3650, Number(c.req.query("days") ?? 30) || 0));
  return c.json(await adminStats(days));
});
admin.get("/admin/feedback", async (c) => {
  const status = c.req.query("status");
  return c.json(await listFeedback({ status: status === "new" || status === "done" ? status : undefined }));
});
admin.patch("/admin/feedback/:id", async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  if (b.status !== "new" && b.status !== "done") return c.json({ error: "status must be new or done" }, 400);
  if (!/^[0-9a-f-]{36}$/i.test(c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return (await setFeedbackStatus(c.req.param("id"), b.status)) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});
admin.get("/admin/usage", async (c) => c.json(await usageLookup(String(c.req.query("who") || "").slice(0, 120))));
admin.post("/admin/lab", async (c) => {
  if (!aiEnabled()) return c.json({ error: "ANTHROPIC_API_KEY isn't set on the server." }, 503);
  const b: any = await c.req.json().catch(() => ({}));
  const models = (Array.isArray(b.models) ? b.models : []).filter((m: unknown) => typeof m === "string" && LAB_MODELS.includes(m));
  if (!models.length) return c.json({ error: "Pick at least one model." }, 400);
  const runs = Math.max(1, Math.min(3, Number(b.runs) || 1));
  const lab = startLab(models, runs);
  return c.json({ id: lab.id, url: `/api/lab/${lab.id}`, total: lab.total });
});
// Anyone with the link can read a lab report: the id is long and random, and reports hold only test data.
admin.get("/lab/:id", (c) => {
  const r = labReport(c.req.param("id"));
  return r ? c.json(r) : c.json({ error: "No such report (they're kept until the next deploy)." }, 404);
});
// Give a person a fresh AI allowance (free actions + the current period of each of their workspaces).
admin.post("/admin/usage/reset", async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const who = String(b.who || "").trim().toLowerCase();
  if (!who) return c.json({ error: "Who?" }, 400);
  const [u] = await getDb().select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${who} or ${users.phone} = ${who}`).limit(1);
  if (!u) return c.json({ error: "No one found with exactly that email or phone." }, 404);
  return c.json({ ok: true, ...(await resetAllowance(u.id)) });
});
