import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { messages, records, sections } from "../db/schema.js";
import { aiEnabled, generateCustomView, understand } from "../ai/claude.js";
import type { UnderstandingT } from "../ai/schemas.js";
import { publish } from "../realtime.js";
import { applyCommands, applyOps, buildSnapshot, type Ctx, type Effect } from "./apply.js";
import { localStructure, looksLikeQuestion } from "./localParser.js";
import { billingStatus, recordUsage, type Billing } from "./billing.js";
import { env } from "../env.js";
import { sanitizeView } from "./views.js";
import { and } from "drizzle-orm";

export type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
/** A shared or attached document: a PDF (base64) or plain text (e.g. a WhatsApp chat export). */
export type DocInput = { name: string; mediaType: "application/pdf" | "text/plain"; data: string };

export type SendInput = {
  text: string;
  images: ImageInput[];
  docs?: DocInput[];
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
    : `You've used your ${env.freeActions} free AI actions, so questions, screenshots and view changes are paused. Plain records are still saved.`;
}

function attachmentLabel(images: number, docs: DocInput[]) {
  const parts: string[] = [];
  if (images) parts.push(images > 1 ? `${images} screenshots` : "Screenshot");
  for (const d of docs) parts.push(d.name || (d.mediaType === "application/pdf" ? "PDF" : "Text file"));
  return parts.join(" · ");
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
  const docs = input.docs ?? [];
  const hasImg = input.images.length > 0 || docs.length > 0; // anything Claude has to read

  const [msg] = await db.insert(messages).values({
    workspaceId: ws, userId: ctx.userId, authorName: ctx.authorName,
    text: input.text || attachmentLabel(input.images.length, docs),
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
        text: input.text, snapshot: await buildSnapshot(ws), contextRecordId: input.contextRecordId, images: input.images, docs,
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
      ai.commands = await drawCustomViews(ws, ai.commands, (u) => recordUsage(ws, ctx.userId, u));
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
          ? `Sorry — I couldn't read ${docs.length ? "that file" : "that screenshot"} just now. Please try again in a moment.`
          : `I can't read ${docs.length ? "files" : "screenshots"} yet — my AI isn't switched on for this workspace. Type it out and I'll still save it.`);
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


/**
 * Custom views arrive from Claude as a spec ("a funnel with one layer per column…"). Before the command is
 * applied, the spec is turned into drawing code (with the section's real fields and a sample of records),
 * so the view appears in the same reply. When a custom view is changed, its previous code is the starting point.
 */
async function drawCustomViews(ws: string, commands: UnderstandingT["commands"], onUsage: (u: any) => void | Promise<void>) {
  const db = getDb();
  return Promise.all(commands.map(async (cmd) => {
    if (cmd.type !== "addView" || !cmd.section) return cmd;
    const v = sanitizeView(cmd.view);
    if (!v || v.type !== "custom" || !v.spec || v.code) return cmd;
    const [sec] = await db.select().from(sections).where(and(eq(sections.workspaceId, ws), eq(sections.name, cmd.section))).limit(1);
    const recs = sec ? await db.select({ fields: records.fields }).from(records).where(eq(records.sectionId, sec.id)).limit(500) : [];
    const names = [...new Set(recs.flatMap((r) => Object.keys(r.fields)))].slice(0, 60);
    const fields = names.map((name) => {
      const vals = recs.map((r) => r.fields[name]).filter((x) => x != null && String(x).trim() !== "");
      return { name, filled: vals.length, examples: [...new Set(vals.map((x) => String(x).slice(0, 40)))].slice(0, 4) };
    });
    const previous = ((sec?.views as any[]) || []).map(sanitizeView).find((x) => x && x.type === "custom" && x.name.toLowerCase() === v.name.toLowerCase())?.code || "";
    try {
      const out = await generateCustomView({ section: cmd.section, spec: v.spec, previous: previous || undefined, fields, count: recs.length,
        sample: recs.slice(0, 15).map((r) => Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, String(x).slice(0, 60)]))), onUsage });
      if (out?.code) v.code = out.code.replace(/^```(?:js|javascript)?\s*|```\s*$/g, "").trim();
    } catch (e) { console.error("[ai] custom view failed", e); }
    if (!v.code && previous) v.code = previous; // keep the old drawing rather than break the view
    return { ...cmd, view: JSON.stringify(v) };
  }));
}
