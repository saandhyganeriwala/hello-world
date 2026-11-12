// Deleting an account (required by the App Store and Google Play, and available on the web too).
//  - Workspaces the person shares with others stay with the team; if they owned one, the longest-standing
//    teammate becomes the owner.
//  - Workspaces nobody else has joined are deleted with all their records; an active subscription on them
//    is cancelled so it isn't charged again.
//  - Their membership rows, sessions and login codes go; the user row goes last (records and messages they
//    wrote stay with the team, showing the name they had).
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { members, otpCodes, subscriptions, users, workspaces } from "../db/schema.js";

export type DeleteResult = { deletedWorkspaces: string[]; handedOver: string[]; subscriptionsToCancel: string[] };

export async function deleteAccount(userId: string): Promise<DeleteResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return { deletedWorkspaces: [], handedOver: [], subscriptionsToCancel: [] };
    const mine = await tx.select({ ws: members.workspaceId }).from(members).where(eq(members.userId, userId));
    const owned = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.createdBy, userId));
    const ids = [...new Set([...mine.map((m) => m.ws), ...owned.map((w) => w.id)])];
    const out: DeleteResult = { deletedWorkspaces: [], handedOver: [], subscriptionsToCancel: [] };
    for (const wsId of ids) {
      const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
      if (!w) continue;
      const [heir] = await tx.select().from(members)
        .where(and(eq(members.workspaceId, wsId), isNotNull(members.userId), ne(members.userId, userId)))
        .orderBy(asc(members.createdAt)).limit(1);
      if (!heir) {
        const subs = await tx.select({ id: subscriptions.subscriptionId, status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.workspaceId, wsId));
        out.subscriptionsToCancel.push(...subs.filter((s) => ["active", "pending", "authenticated", "created", "cancelling"].includes(s.status)).map((s) => s.id));
        await tx.delete(workspaces).where(eq(workspaces.id, wsId)); // records, sections, messages, members… cascade
        out.deletedWorkspaces.push(w.name);
        continue;
      }
      if (w.createdBy === userId) {
        await tx.update(workspaces).set({ createdBy: heir.userId }).where(eq(workspaces.id, wsId));
        await tx.update(members).set({ role: "owner" }).where(eq(members.id, heir.id));
        out.handedOver.push(w.name);
      }
      await tx.delete(members).where(and(eq(members.workspaceId, wsId), eq(members.userId, userId)));
    }
    if (u.email) await tx.delete(otpCodes).where(eq(otpCodes.target, u.email));
    if (u.phone) await tx.delete(otpCodes).where(eq(otpCodes.target, u.phone));
    await tx.delete(users).where(eq(users.id, userId)); // sessions cascade
    return out;
  });
}
