import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DB, Tx } from "../db/client.js";
import { getDb } from "../db/client.js";
import { members, messages, records, sections, workspaces } from "../db/schema.js";
import type { AuthUser } from "../auth/session.js";
import { maskContact } from "../lib/identity.js";
import { MEMBER_COLORS } from "./helpers.js";
import { billingStatus } from "./billing.js";
import crypto from "node:crypto";

// No 0/o/1/l/i, so a code read aloud or typed from a screenshot comes out right.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newInviteCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Returns the workspace's invite code, creating one for workspaces made before invite links existed. */
export async function ensureInviteCode(workspaceId: string, current: string | null) {
  if (current) return current;
  const code = newInviteCode();
  const [w] = await getDb().update(workspaces).set({ inviteCode: code })
    .where(and(eq(workspaces.id, workspaceId), sql`${workspaces.inviteCode} is null`)).returning({ code: workspaces.inviteCode });
  if (w?.code) return w.code;
  const [again] = await getDb().select({ code: workspaces.inviteCode }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return again?.code ?? code;
}

const MESSAGE_WINDOW = 300;

export async function getMembership(userId: string, workspaceId: string) {
  const [m] = await getDb().select().from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId))).limit(1);
  return m ?? null;
}

export async function listWorkspaces(userId: string) {
  return getDb().select({ id: workspaces.id, name: workspaces.name, role: members.role })
    .from(members).innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(eq(members.userId, userId)).orderBy(asc(workspaces.createdAt));
}

export async function nextColor(db: DB | Tx, workspaceId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.workspaceId, workspaceId));
  return MEMBER_COLORS[n % MEMBER_COLORS.length];
}

export async function createWorkspace(user: AuthUser, name: string) {
  return getDb().transaction(async (tx) => {
    const [w] = await tx.insert(workspaces).values({ name: name.trim() || "My workspace", createdBy: user.id, inviteCode: newInviteCode() }).returning();
    await tx.insert(members).values({
      workspaceId: w.id, userId: user.id, email: user.email, phone: user.phone, name: user.name, role: "owner", color: MEMBER_COLORS[0],
    });
    return w.id;
  });
}

/** Everything the client renders for one workspace, in the shape the UI expects. */
export async function loadState(workspaceId: string, userId: string) {
  const db = getDb();
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!w) return null;
  const [mem, secs, recs, msgs] = await Promise.all([
    db.select().from(members).where(eq(members.workspaceId, workspaceId)).orderBy(asc(members.createdAt)),
    db.select().from(sections).where(eq(sections.workspaceId, workspaceId)).orderBy(asc(sections.position), asc(sections.createdAt)),
    db.select().from(records).where(eq(records.workspaceId, workspaceId)).orderBy(desc(records.updatedAt)),
    db.select().from(messages).where(eq(messages.workspaceId, workspaceId)).orderBy(desc(messages.createdAt)).limit(MESSAGE_WINDOW),
  ]);
  const secName = new Map(secs.map((s) => [s.id, s.name]));
  const inviteCode = await ensureInviteCode(w.id, w.inviteCode);
  const billing = await billingStatus(w.id);
  const me = mem.find((m) => m.userId === userId);
  return {
    id: w.id,
    name: w.name,
    accent: w.accent,
    inviteCode,
    billing,
    me: userId,
    active: userId,
    role: me?.role ?? "member",
    members: mem.map((m) => ({
      id: m.userId ?? `invite:${m.id}`,
      memberId: m.id,
      name: m.name || (m.userId === userId ? "You" : "Teammate"),
      color: m.color,
      role: m.role,
      pending: !m.userId,
      contact: m.userId === userId ? (m.email || m.phone || "") : maskContact(m.email || m.phone),
    })),
    sections: Object.fromEntries(secs.map((s) => [s.name, { name: s.name, icon: s.icon, kind: s.kind, sort: s.sort, views: s.views ?? [] }])),
    order: secs.map((s) => s.name),
    records: recs.map((r) => ({
      id: r.id,
      section: secName.get(r.sectionId) ?? "",
      fields: r.fields,
      history: r.history,
      author: r.authorName,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    })),
    messages: msgs.reverse().map((m) => ({
      id: m.id,
      role: m.role === "assistant" ? "assistant" : undefined,
      author: m.userId,
      authorName: m.authorName,
      text: m.text,
      images: m.images ?? undefined,
      pending: m.pending,
      tag: m.tag,
      tagIcon: m.tagIcon,
      rid: m.recordId,
      ts: m.createdAt.getTime(),
    })),
  };
}

export type WorkspaceState = NonNullable<Awaited<ReturnType<typeof loadState>>>;
