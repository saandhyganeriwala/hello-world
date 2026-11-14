import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { toJSONSchema, type z } from "zod/v4";
import { env, type Effort } from "../env.js";
import { CUSTOM_VIEW_SYSTEM, IMPORT_SYSTEM, UNDERSTAND_SYSTEM } from "./prompts.js";
import { CustomViewOut, ImportPlan, Understanding, type CustomViewOutT, type ImportPlanT, type UnderstandingT } from "./schemas.js";

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null;
export const aiEnabled = () => client !== null;

// Server-side refusal fallback (beta). If the API ever rejects the parameter,
// we drop it for the rest of the process instead of failing every request.
let useFallbacks = env.claudeFallbacks;

export class AiUnavailable extends Error {}

type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
type DocInput = { name: string; mediaType: "application/pdf" | "text/plain"; data: string };

// What one Claude call used — the server prices it and charges the workspace (src/domain/billing.ts).
export type AiUsage = { label: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };
export type OnUsage = (u: AiUsage) => unknown;

// The system prompt is cached for an hour (writes cost 2× input, reads 0.1×): messages spread
// through a working day keep hitting the cache instead of re-writing it every 5 minutes.
// Strict structured outputs first. If the API ever rejects the schema (grammar too large / too complex),
// switch to plain JSON for the rest of the process and validate it here, instead of failing every message.
let useStrict = true;
const SCHEMA_ERR = /grammar|schema|too complex|compil/i;

function firstJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

async function structured<S extends z.ZodType>(
  schema: S, system: string, content: Anthropic.Beta.BetaContentBlockParam[], effort: Effort, label: string,
  opts: { normalize?: (raw: any) => unknown; onUsage?: OnUsage } = {},
): Promise<z.infer<S> | null> {
  if (!client) throw new AiUnavailable("ANTHROPIC_API_KEY is not set");
  const strict = useStrict;
  const sys: any[] = [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
  if (!strict) {
    sys[0] = { type: "text", text: system };
    sys.push({ type: "text", cache_control: { type: "ephemeral", ttl: "1h" }, text:
      "Reply with ONLY one JSON object — no prose, no code fences — matching this JSON Schema exactly (every property present):\n" +
      JSON.stringify(toJSONSchema(schema)) });
  }
  const params: any = {
    model: env.claudeModel,
    max_tokens: 16000,
    system: sys,
    messages: [{ role: "user", content }],
    output_config: strict ? { effort, format: betaZodOutputFormat(schema) } : { effort },
  };
  if (useFallbacks) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }

  const started = Date.now();
  let res: any;
  try {
    res = strict ? await client.beta.messages.parse(params) : await client.beta.messages.create(params);
  } catch (e) {
    if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
      console.warn("[ai] server-side fallback not accepted; continuing without it");
      useFallbacks = false;
      return structured(schema, system, content, effort, label, opts);
    }
    if (strict && e instanceof Anthropic.BadRequestError && SCHEMA_ERR.test(e.message)) {
      console.warn("[ai] structured output schema rejected; switching to validated JSON:", e.message);
      useStrict = false;
      return structured(schema, system, content, effort, label, opts);
    }
    throw e;
  }
  const u = res.usage as any;
  const usage: AiUsage = {
    label, model: res.model || env.claudeModel,
    input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
  console.log(JSON.stringify({ ai: label, model: usage.model, ms: Date.now() - started, stop: res.stop_reason, strict,
    in: usage.input, out: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }));
  try { await opts.onUsage?.(usage); } catch (e) { console.error("[ai] usage metering failed", e); }
  if (res.stop_reason === "refusal") {
    console.warn("[ai] refusal", res.stop_details?.category);
    return null;
  }
  if (strict) return (res.parsed_output as z.infer<S> | null) ?? null;
  const text = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  const raw = firstJson(text);
  if (!raw) { console.warn("[ai] no JSON in reply"); return null; }
  const fixed = opts.normalize ? opts.normalize(raw) : raw;
  const ok = schema.safeParse(fixed);
  if (!ok.success) { console.warn("[ai] reply did not match the schema", ok.error.issues.slice(0, 3)); return null; }
  return ok.data;
}

// Fills anything a plain-JSON reply left out, so it validates like a strict one.
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
function normalizeUnderstanding(r: any) {
  const kinds = ["record", "question", "command", "chatter"];
  return {
    kind: kinds.includes(r?.kind) ? r.kind : "chatter",
    operations: arr(r?.operations).map((o: any) => ({
      op: ["create", "update", "delete"].includes(o?.op) ? o.op : "create",
      section: str(o?.section), sectionIcon: str(o?.sectionIcon), sectionKind: o?.sectionKind || "generic",
      recordId: str(o?.recordId),
      fields: Array.isArray(o?.fields) ? o.fields.map((f: any) => ({ key: str(f?.key), value: str(f?.value) }))
        : Object.entries(o?.fields || {}).map(([key, value]) => ({ key, value: str(value) })),
      sectionView: str(o?.sectionView),
    })),
    commands: arr(r?.commands).map((c: any) => ({
      type: c?.type, section: str(c?.section), from: str(c?.from), to: str(c?.to), into: str(c?.into), name: str(c?.name),
      kind: c?.kind || "", icon: str(c?.icon), field: str(c?.field), value: str(c?.value), by: str(c?.by),
      dir: ["asc", "desc"].includes(c?.dir) ? c.dir : "", mode: ["light", "dark", "system"].includes(c?.mode) ? c.mode : "",
      accent: str(c?.accent), order: arr(c?.order).map(str), view: str(c?.view),
    })),
    answer: str(r?.answer), focus: str(r?.focus),
  };
}
function normalizeImport(r: any) {
  return { sheets: arr(r?.sheets).map((s: any) => ({ sheet: str(s?.sheet), sections: arr(s?.sections).map((x: any) => ({
    name: str(x?.name), kind: x?.kind || "generic", icon: str(x?.icon), titleField: str(x?.titleField), statusField: str(x?.statusField),
    fields: arr(x?.fields).map((f: any) => ({ name: str(f?.name), source: str(f?.source) })),
    matchColumn: str(x?.matchColumn), matchValues: arr(x?.matchValues).map(str) })) })) };
}

export type Snapshot = {
  sections: { name: string; kind: string; fields: string[]; views: { name: unknown; type: unknown }[] }[];
  records: { id: string; section: string; title: string; fields: Record<string, string> }[];
};

export async function understand(input: {
  text: string; snapshot: Snapshot; contextRecordId?: string | null; images?: ImageInput[]; docs?: DocInput[];
  viewing?: { section: string; view: unknown } | null;
  onUsage?: OnUsage;
}): Promise<UnderstandingT | null> {
  const imgs = input.images ?? [];
  const docs = input.docs ?? [];
  const notes: string[] = [];
  if (input.contextRecordId) {
    notes.push(`The team member is CURRENTLY viewing record id "${input.contextRecordId}". If this message changes a record, it most likely means that one.`);
  }
  if (input.viewing?.section) {
    const shown: any = input.viewing.view && typeof input.viewing.view === "object" ? { ...(input.viewing.view as any) } : input.viewing.view;
    if (shown && typeof shown === "object") delete shown.code; // a custom view's drawing code isn't needed here; its spec is
    notes.push(`They are looking at the "${input.viewing.section}" section in this view: ${JSON.stringify(shown).slice(0, 4000)}. "Only show…", "filter…", "group by…", "sort…", "hide…", "show … as …" or "change this…" most likely means changing THIS view — return addView with the same view name and the full updated view (for a custom view: type "custom" and the full updated spec).`);
  }
  if (/^\s*@?\s*crud\b/i.test(input.text) || /^\s*hey\s+crud\b/i.test(input.text)) {
    notes.push("They tagged you (CRUD) directly — expect a command or a question, not a new record, unless they clearly state a business fact.");
  }
  if (imgs.length) {
    notes.push(`They attached ${imgs.length} image(s) — usually a screenshot of an order, a WhatsApp chat, an invoice, a receipt or a list. The image is the main content: read it carefully and extract the record(s). One screenshot can hold several records — return one operation per record. Default to "record" unless the image is clearly just a question.`);
  }
  if (docs.length) {
    notes.push(`They shared ${docs.length} file(s): ${docs.map((d) => `"${d.name}"`).join(", ")} — e.g. an invoice, bill, purchase order, price list, bank statement or an exported WhatsApp chat. The file is the main content: read it and extract the record(s) it holds — one operation per record (a statement or chat can hold many; stick to clear business facts such as orders, payments, deliveries and tasks). Default to "record" unless the message text clearly asks a question about the file.`);
  }
  const text =
    `Existing sections and recent records (JSON):\n${JSON.stringify(input.snapshot)}\n\n` +
    `New message from a team member:\n"""${input.text || (imgs.length || docs.length ? "(no text — see the attached " + (docs.length ? "file" : "image") + ")" : "")}"""` +
    (notes.length ? `\n\n${notes.join("\n")}` : "");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...docs.map((d) => d.mediaType === "application/pdf"
      ? ({ type: "document" as const, title: d.name.slice(0, 200), source: { type: "base64" as const, media_type: "application/pdf" as const, data: d.data } })
      : ({ type: "document" as const, title: d.name.slice(0, 200), source: { type: "text" as const, media_type: "text/plain" as const, data: d.data } })),
    ...imgs.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
    { type: "text", text },
  ];
  const heavy = imgs.length > 0 || docs.length > 0;
  return structured(Understanding, UNDERSTAND_SYSTEM, content, heavy ? env.effortHeavy : env.effortChat,
    docs.length ? "understand+file" : imgs.length ? "understand+image" : "understand", { normalize: normalizeUnderstanding, onUsage: input.onUsage });
}

export async function planImport(input: {
  sheets: { sheet: string; headers: string[]; columns?: { header: string; filled: number; of: number; examples: string[] }[]; sample: Record<string, string>[] }[];
  existing: { name: string; kind: string }[];
  onUsage?: OnUsage;
}): Promise<ImportPlanT | null> {
  const text =
    `Sheets (headers, every column with how many rows have a value and example values, plus sample rows):\n${JSON.stringify(input.sheets)}\n\n` +
    `Existing sections: ${JSON.stringify(input.existing)}`;
  return structured(ImportPlan, IMPORT_SYSTEM, [{ type: "text", text }], env.effortHeavy, "import-plan",
    { normalize: normalizeImport, onUsage: input.onUsage });
}

/** Writes (or rewrites) a custom view's drawing code from its spec. See CUSTOM_VIEW_SYSTEM. */
export async function generateCustomView(input: {
  section: string; spec: string; previous?: string;
  fields: { name: string; filled: number; examples: string[] }[]; count: number; sample: Record<string, string>[];
  onUsage?: OnUsage;
}): Promise<CustomViewOutT | null> {
  const text =
    `Section: ${input.section} (${input.count} records)\n` +
    `Fields (how many records have a value, and example values):\n${JSON.stringify(input.fields)}\n\n` +
    `Sample records:\n${JSON.stringify(input.sample)}\n\n` +
    (input.previous ? `Previous code (change it as the spec says):\n${input.previous}\n\n` : "") +
    `Spec:\n${input.spec}`;
  return structured(CustomViewOut, CUSTOM_VIEW_SYSTEM, [{ type: "text", text }], env.effortHeavy, "custom-view", { onUsage: input.onUsage });
}
