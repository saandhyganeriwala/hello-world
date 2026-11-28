import type { Prisma } from "@prisma/client";
import db from "../db.server";

type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
interface Op {
  query: string;
  variables?: Record<string, unknown>;
}

/** Runs frozen GraphQL operations in order; stops at the first error or userErrors. */
async function runOps(graphql: AdminGraphql, ops: Op[]) {
  const results: unknown[] = [];
  for (const op of ops) {
    const res = await graphql(op.query, { variables: op.variables });
    const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
    if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 500)}`);
    const userErrors = Object.values(json.data ?? {}).flatMap(
      (payload) => ((payload as { userErrors?: { message: string }[] } | null)?.userErrors ?? []),
    );
    if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
    results.push(json.data);
  }
  return results;
}

/**
 * Executes a pending action exactly as frozen. Used by the admin Activity page; the WhatsApp
 * button handler calls the same function, so both paths behave identically.
 */
export async function decidePendingAction(opts: {
  graphql: AdminGraphql;
  shopId: string;
  actionId: string;
  decision: "approve" | "reject";
  decidedBy: string;
  via: "admin" | "whatsapp";
}) {
  const action = await db.pendingAction.findFirst({ where: { id: opts.actionId, shopId: opts.shopId } });
  if (!action) return { ok: false as const, message: "This request no longer exists." };
  if (action.status !== "pending") return { ok: false as const, message: "This request was already handled." };

  const decided = { decidedBy: opts.decidedBy, decidedVia: opts.via, decidedAt: new Date() };

  if (action.expiresAt < new Date()) {
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "expired", ...decided } });
    return { ok: false as const, message: "This request expired. Ask the assistant again on WhatsApp." };
  }
  if (opts.decision === "reject") {
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "rejected", ...decided } });
    return { ok: true as const, message: "Cancelled." };
  }

  // Claim the action first so a double click or a WhatsApp tap can't run it twice.
  const claimed = await db.pendingAction.updateMany({
    where: { id: action.id, status: "pending" },
    data: { status: "approved", ...decided },
  });
  if (claimed.count === 0) return { ok: false as const, message: "This request was already handled." };

  try {
    const results = await runOps(opts.graphql, action.ops as unknown as Op[]);
    await db.auditEvent.create({
      data: {
        shopId: opts.shopId,
        actor: opts.via === "admin" ? "merchant" : "agent",
        tool: action.tool,
        summary: action.summary,
        status: "done",
        undoOps: (action.undoOps ?? undefined) as Prisma.InputJsonValue | undefined,
        pendingActionId: action.id,
        details: { results } as Prisma.InputJsonValue,
      },
    });
    return { ok: true as const, message: "Approved and applied." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.pendingAction.update({ where: { id: action.id }, data: { status: "failed" } });
    await db.auditEvent.create({
      data: {
        shopId: opts.shopId,
        actor: "agent",
        tool: action.tool,
        summary: action.summary,
        status: "failed",
        pendingActionId: action.id,
        details: { error: message },
      },
    });
    return { ok: false as const, message: `Shopify rejected the change: ${message}` };
  }
}

export async function undoAuditEvent(opts: { graphql: AdminGraphql; shopId: string; eventId: string }) {
  const event = await db.auditEvent.findFirst({ where: { id: opts.eventId, shopId: opts.shopId } });
  if (!event || event.status !== "done" || !event.undoOps) {
    return { ok: false as const, message: "This change can't be undone." };
  }
  const claimed = await db.auditEvent.updateMany({
    where: { id: event.id, status: "done" },
    data: { status: "undone", undoneAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false as const, message: "Already undone." };
  try {
    await runOps(opts.graphql, event.undoOps as unknown as Op[]);
    await db.auditEvent.create({
      data: { shopId: opts.shopId, actor: "merchant", tool: "undo", summary: `Undid: ${event.summary}` },
    });
    return { ok: true as const, message: "Change undone." };
  } catch (error) {
    await db.auditEvent.update({ where: { id: event.id }, data: { status: "done", undoneAt: null } });
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, message: `Couldn't undo: ${message}` };
  }
}
