import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { messages, records } from "../db/schema.js";
import { aiEnabled, understand } from "../ai/claude.js";
import type { UnderstandingT } from "../ai/schemas.js";
import { publish } from "../realtime.js";
import { applyCommands, applyOps, buildSnapshot, type Ctx, type Effect } from "./apply.js";
import { localStructure, looksLikeQuestion } from "./localParser.js";

export type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

export type SendInput = {
  text: string;
  images: ImageInput[];
  thumbs: string[];
  contextRecordId: string | null;
  clientId: string;
};

export type SendResult = {
  kind: UnderstandingT["kind"] | "fallback" | "error";
  section: string | null;
  rid: string | null;
  touched: string[];
  isNew: boolean;
  focus: string | null;
};

const addressed = (t: string) => /^\s*@?\s*crud\b/i.test(t) || /^\s*hey\s+crud\b/i.test(t);

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

  const result: SendResult = { kind: "chatter", section: null, rid: null, touched: [], isNew: false, focus: null };
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
  if (aiEnabled()) {
    try {
      ai = await understand({
        text: input.text, snapshot: await buildSnapshot(ws), contextRecordId: input.contextRecordId, images: input.images,
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
      if (hasImg) {
        result.kind = "error";
        await botReply(ws, aiEnabled()
          ? "I couldn't read that screenshot just now. Try again in a moment."
          : "Reading screenshots needs Claude to be connected (ANTHROPIC_API_KEY).");
      } else if (addressed(input.text) || looksLikeQuestion(input.text)) {
        result.kind = "error";
        await botReply(ws, aiEnabled()
          ? "I couldn't reach my brain just now — try again in a moment."
          : "Answering questions and changing the interface needs Claude to be connected (ANTHROPIC_API_KEY).");
      } else {
        result.kind = "fallback";
        const recs = (await buildSnapshot(ws)).records;
        const ops = localStructure(input.text, input.contextRecordId, recs);
        const out = await db.transaction((tx) => applyOps(tx, ctx, ops));
        Object.assign(result, { section: out.section, rid: out.rid, touched: out.touched, isNew: out.isNew });
        tag = { tag: out.tag, tagIcon: out.tagIcon, recordId: out.rid };
        if (aiFailed) console.warn("[ai] used local fallback after an AI failure");
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
