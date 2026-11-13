// Feedback people send from the app (Menu → Send feedback). Admins read it on /admin, and get an email
// for each new message when email is set up (EMAIL_PROVIDER) and ADMIN_EMAILS is set.
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { feedback, users, workspaces } from "../db/schema.js";
import { env } from "../env.js";
import { sendEmail } from "../auth/email.js";
import { esc } from "./helpers.js";

export const FEEDBACK_MAX = 4000;

export function platformOf(ua: string) {
  return /CRUDchatApp iOS/.test(ua) ? "ios" : /CRUDchatApp Android/.test(ua) ? "android" : "web";
}

export async function saveFeedback(input: { userId: string; workspaceId: string | null; text: string; page: string; userAgent: string }) {
  const db = getDb();
  const [row] = await db.insert(feedback).values({
    userId: input.userId, workspaceId: input.workspaceId, text: input.text.slice(0, FEEDBACK_MAX),
    platform: platformOf(input.userAgent), page: input.page.slice(0, 120) || null, userAgent: input.userAgent.slice(0, 300) || null,
  }).returning();
  notifyAdmins(row.id).catch((e) => console.error("[feedback] notify", e?.message));
  return row;
}

export async function listFeedback(opts: { limit?: number; status?: string } = {}) {
  const db = getDb();
  const q = db.select({
    id: feedback.id, text: feedback.text, platform: feedback.platform, page: feedback.page, status: feedback.status, createdAt: feedback.createdAt,
    name: users.name, email: users.email, phone: users.phone, userCreatedAt: users.createdAt,
    workspace: workspaces.name, workspacePlan: workspaces.plan, workspacePlanUntil: workspaces.planUntil,
  }).from(feedback)
    .leftJoin(users, eq(users.id, feedback.userId))
    .leftJoin(workspaces, eq(workspaces.id, feedback.workspaceId));
  const rows = await (opts.status ? q.where(eq(feedback.status, opts.status)) : q)
    .orderBy(desc(feedback.createdAt)).limit(Math.min(500, opts.limit ?? 200));
  const [counts] = (await db.select({
    total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${feedback.status} = 'new')::int`,
  }).from(feedback));
  return {
    counts: { total: Number(counts?.total ?? 0), open: Number(counts?.open ?? 0) },
    items: rows.map((r) => ({
      id: r.id, text: r.text, platform: r.platform || "web", page: r.page || "", status: r.status, createdAt: r.createdAt,
      user: r.email || r.phone ? { name: r.name || "", contact: r.email || r.phone || "", since: r.userCreatedAt } : null,
      workspace: r.workspace ? { name: r.workspace, pro: !!(r.workspacePlanUntil && r.workspacePlanUntil > new Date()) } : null,
    })),
  };
}

export async function setFeedbackStatus(id: string, status: "new" | "done") {
  const r = await getDb().update(feedback).set({ status }).where(eq(feedback.id, id)).returning({ id: feedback.id });
  return r.length > 0;
}

async function notifyAdmins(id: string) {
  if (!env.emailProvider || !env.adminEmails.length) return;
  const { items } = await listFeedback({ limit: 1 });
  const f = items.find((x) => x.id === id); if (!f) return;
  const who = f.user ? `${f.user.name || "Someone"} (${f.user.contact})` : "Someone";
  const where = [f.workspace?.name, f.platform, f.page].filter(Boolean).join(" · ");
  const text = `${who} sent feedback${where ? ` — ${where}` : ""}:\n\n${f.text}\n\nAll feedback: https://crud.chat/admin#feedback`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141414;max-width:560px">
<p style="color:#46433D;margin:0 0 10px"><b>${esc(who)}</b> sent feedback${where ? ` · ${esc(where)}` : ""}</p>
<div style="background:#FFFEFA;border:2px solid #141414;border-radius:14px;padding:14px 16px;white-space:pre-wrap;font-size:15px;line-height:1.5">${esc(f.text)}</div>
<p style="margin:16px 0 0"><a href="https://crud.chat/admin#feedback" style="color:#0E8A8A">All feedback</a></p></div>`;
  const replyTo = f.user && f.user.contact.includes("@") ? f.user.contact : undefined;
  await sendEmail({ to: env.adminEmails, subject: `Feedback: ${f.text.replace(/\s+/g, " ").slice(0, 60)}`, text, html, tag: "feedback", replyTo });
}
