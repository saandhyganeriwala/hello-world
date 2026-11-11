import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { messages, records } from "../db/schema.js";
import { aiEnabled, understand } from "../ai/claude.js";
import type { UnderstandingT } from "../ai/schemas.js";
import { publish } from "../realtime.js";
import { applyCommands, applyOps, buildSnapshot, type Ctx, type Effect } from "./apply.js";
import { localStructure, looksLikeQuestion } from "./localParser.js";
import { billingStatus, recordUsage, type Billing } from "./billing.js";
import { env } from "../env.js";

export type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

export type SendInput = {
  text: string;
  images: ImageInput[];
  thumbs: string[];
  contextRecordId: string | null;
  clientId: string;
  viewing?: { section: string; view: unknown } | null;
};

export type SendResult = {
  kind: UnderstandingT["kind"] | "fallback" | "error" | "limit";
  section: string | null;
  rid: string | null;
  touched: string[];
  isNew: boolean;
  focus: string | null;
  view: string | null;
};

const addressed = (t: string) => /^\s*@?\s*crud\b/i.test(t) || /^\s*hey\s+crud\b/i.test(t);
// "Add a filter…", "Create a water tracker…", "Show orders as a chart" — instructions, never notes.
const looksLikeCommand = (t: string) =>
  /^\s*(pls|please|kindly|can you|could you|i want|i need|let'?s)?\s*(add|create|make|set ?up|build|show|display|filter|sort|group|rename|delete|remove|change|hide|turn|switch|track|start tracking|give me)\b/i.test(t)
  && /\b(filter|sort|group|view|chart|graph|pie|kanban|board|pipeline|tracker|dashboard|table|calendar|column|field|section|tab|theme|colou?r|accent|workspace|track)\b/i.test(t);

function limitMessage(b: Billing) {
  return b.plan === "pro"
    ? `You've used this month's fair-usage AI allowance — it resets on ${new Date(b.periodEnds ?? Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}. Plain records are still saved.`
    : `You've used your ${env.freeActions} free AI actions. Upgrade to Pro to keep asking questions, reading screenshots and changing views. Plain records are still saved.`;
}

async function botReply(workspaceId: string, text: string) {
  await getDb().insert(messages).values({ workspaceId, role: "assistant", authorName: "CRUD", text });
}

/**
 * The whole "someone sent a message" flow:
 * save it → ask Claude what it means → record / answer / change the UI / ignore → tell teammates.
 */
export async function processMessage(ctx: Ctx, input: SendInput): Promise<{ result: SendResult; effects: Effect[] }> {
  const db = getDb();
  const ws = ctx.workspaceId;
  const hasImg = input.images.length > 0;

  const [msg] = await db.insert(messages).values({
    workspaceId: ws, userId: ctx.userId, authorName: ctx.authorName,
    text: input.text || (hasImg ? (input.images.length > 1 ? `${input.images.length} screenshots` : "Screenshot") : ""),
    images: input.thumbs.length ? input.thumbs : null, pending: true,
  }).returning();
  publish(ws, { type: "change", by: input.clientId });

  const result: SendResult = { kind: "chatter", section: null, rid: null, touched: [], isNew: false, focus: null, view: null };
  let effects: Effect[] = [];
  let tag: { tag: string; tagIcon: string; recordId: string | null } | null = null;

  // Validate the record the sender is looking at (for "select a record, then speak").
  if (input.contextRecordId) {
    const [r] = await db.select({ ws: records.workspaceId }).from(records).where(eq(records.id, input.contextRecordId)).limit(1);
    if (!r || r.ws !== ws) input.contextRecordId = null;
  }
  ctx.contextRecordId = input.contextRecordId;
  ctx.messageText = input.text;

  let ai: UnderstandingT | null = null;
  let aiFailed = false;
  const bill = aiEnabled() ? await billingStatus(ws) : null;
  const outOfCredit = !!bill && !bill.ok;
  if (aiEnabled() && !outOfCredit) {
    try {
      ai = await understand({
        onUsage: (u) => recordUsage(ws, ctx.userId, u),
        text: input.text, snapshot: await buildSnapshot(ws), contextRecordId: input.contextRecordId, images: input.images,
        viewing: input.viewing ?? null,
      });
      if (!ai) aiFailed = true; // refusal or unparseable
    } catch (e) {
      aiFailed = true;
      console.error("[ai] understand failed", e);
    }
  }

  try {
    if (ai?.kind === "question") {
      result.kind = "question";
      result.focus = ai.focus || null;
      await botReply(ws, ai.answer.trim() || "I don't have anything on that yet.");
    } else if (ai?.kind === "command") {
      result.kind = "command";
      const out = await db.transaction((tx) => applyCommands(tx, ctx, ai!.commands));
      effects = out.effects;
      result.focus = out.goto || ai.focus || null;
      result.view = out.gotoView;
      await botReply(ws, ai.answer.trim() || (out.summary.length ? `Done — ${out.summary.join("; ")}.` : "I couldn't make that change — tell me the section and what to change."));
    } else if (ai?.kind === "chatter") {
      result.kind = "chatter";
    } else if (ai?.kind === "record" && ai.operations.length) {
      result.kind = "record";
      const out = await db.transaction((tx) => applyOps(tx, ctx, ai!.operations));
      Object.assign(result, { section: out.section, rid: out.rid, touched: out.touched, isNew: out.isNew });
      tag = { tag: out.tag, tagIcon: out.tagIcon, recordId: out.rid };
    } else if (ai?.kind === "record") {
      result.kind = "chatter"; // a "record" with nothing to record
    } else {
      // Claude unavailable (no key, outage, refusal): fall back gracefully.
      if (outOfCredit && (hasImg || addressed(input.text) || looksLikeQuestion(input.text) || looksLikeCommand(input.text))) {
        result.kind = "limit";
        await botReply(ws, limitMessage(bill!));
      } else if (hasImg) {
        result.kind = "error";
        await botReply(ws, aiEnabled()
          ? "Sorry — I couldn't read that screenshot just now. Please try again in a moment."
          : "I can't read screenshots yet — my AI isn't switched on for this workspace. Type it out and I'll still save it.");
      } else if (addressed(input.text) || looksLikeQuestion(input.text) || looksLikeCommand(input.text)) {
        result.kind = "error";
        await botReply(ws, aiEnabled()
          ? "Sorry — something went wrong on my side and I couldn't do that. Please try again in a moment."
          : "I can't answer questions or change the layout yet — my AI isn't switched on for this workspace. Everything you record is still saved.");
      } else {
        result.kind = "fallback";
        const recs = (await buildSnapshot(ws)).records;
        const ops = localStructure(input.text, input.contextRecordId, recs);
        const out = await db.transaction((tx) => applyOps(tx, ctx, ops));
        Object.assign(result, { section: out.section, rid: out.rid, touched: out.touched, isNew: out.isNew });
        tag = { tag: out.tag, tagIcon: out.tagIcon, recordId: out.rid };
        if (aiFailed) console.warn("[ai] used local fallback after an AI failure");
        if (outOfCredit) {
          // Nudge once in a while, not on every record.
          const [last] = await db.select({ text: messages.text, role: messages.role }).from(messages)
            .where(eq(messages.workspaceId, ws)).orderBy(desc(messages.createdAt)).limit(1).offset(1);
          if (!(last?.role === "assistant" && last.text.startsWith("You've used"))) { result.kind = "limit"; await botReply(ws, limitMessage(bill!)); }
        }
      }
    }
  } catch (e) {
    console.error("[messages] processing failed", e);
    result.kind = "error";
    await botReply(ws, "Something went wrong saving that. Please try again.");
  } finally {
    await db.update(messages).set({ pending: false, tag: tag?.tag ?? null, tagIcon: tag?.tagIcon ?? null, recordId: tag?.recordId ?? null })
      .where(eq(messages.id, msg.id));
    publish(ws, { type: "change", by: input.clientId });
  }
  return { result, effects };
}
