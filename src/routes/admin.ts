// Admin analytics + the visit beacon.
//   POST /api/t                → records a page visit (public, no cookies; bots ignored)
//   GET  /api/admin/stats      → dashboard numbers, for emails listed in ADMIN_EMAILS
//   GET  /api/admin/feedback   → feedback people sent from the app (PATCH /api/admin/feedback/:id {status})
import { Hono, type MiddlewareHandler } from "hono";
import { env } from "../env.js";
import { requireUser, type AppEnv } from "../auth/session.js";
import { adminStats, trackVisit, usageLookup } from "../domain/analytics.js";
import { listFeedback, setFeedbackStatus } from "../domain/feedback.js";

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
