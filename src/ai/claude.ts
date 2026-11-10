import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { toJSONSchema, type z } from "zod/v4";
import { env, type Effort } from "../env.js";
import { IMPORT_SYSTEM, UNDERSTAND_SYSTEM } from "./prompts.js";
import { ImportPlan, Understanding, type ImportPlanT, type UnderstandingT } from "./schemas.js";

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null;
export const aiEnabled = () => client !== null;

// Server-side refusal fallback (beta). If the API ever rejects the parameter,
// we drop it for the rest of the process instead of failing every request.
let useFallbacks = env.claudeFallbacks;

export class AiUnavailable extends Error {}

type ImageInput = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

// What one Claude call used — the server prices it and charges the workspace (src/domain/billing.ts).
export type AiUsage = { label: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };
export type OnUsage = (u: AiUsage) => void | Promise<void>;

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
  const sys: any[] = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  if (!strict) {
    sys[0] = { type: "text", text: system };
    sys.push({ type: "text", cache_control: { type: "ephemeral" }, text:
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
  text: string; snapshot: Snapshot; contextRecordId?: string | null; images?: ImageInput[];
  viewing?: { section: string; view: unknown } | null;
  onUsage?: OnUsage;
}): Promise<UnderstandingT | null> {
  const imgs = input.images ?? [];
  const notes: string[] = [];
  if (input.contextRecordId) {
    notes.push(`The team member is CURRENTLY viewing record id "${input.contextRecordId}". If this message changes a record, it most likely means that one.`);
  }
  if (input.viewing?.section) {
    notes.push(`They are looking at the "${input.viewing.section}" section in this view: ${JSON.stringify(input.viewing.view)}. "Only show…", "filter…", "group by…", "sort…", "hide…" or "show … as …" most likely means changing THIS view — return addView with the same view name and the full updated view.`);
  }
  if (/^\s*@?\s*crud\b/i.test(input.text) || /^\s*hey\s+crud\b/i.test(input.text)) {
    notes.push("They tagged you (CRUD) directly — expect a command or a question, not a new record, unless they clearly state a business fact.");
  }
  if (imgs.length) {
    notes.push(`They attached ${imgs.length} image(s) — usually a screenshot of an order, a WhatsApp chat, an invoice, a receipt or a list. The image is the main content: read it carefully and extract the record(s). One screenshot can hold several records — return one operation per record. Default to "record" unless the image is clearly just a question.`);
  }
  const text =
    `Existing sections and recent records (JSON):\n${JSON.stringify(input.snapshot)}\n\n` +
    `New message from a team member:\n"""${input.text || (imgs.length ? "(no text — see the attached image)" : "")}"""` +
    (notes.length ? `\n\n${notes.join("\n")}` : "");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...imgs.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
    { type: "text", text },
  ];
  return structured(Understanding, UNDERSTAND_SYSTEM, content, imgs.length ? env.effortHeavy : env.effortChat,
    imgs.length ? "understand+image" : "understand", { normalize: normalizeUnderstanding, onUsage: input.onUsage });
}

export async function planImport(input: {
  sheets: { sheet: string; headers: string[]; sample: Record<string, string>[] }[];
  existing: { name: string; kind: string }[];
  onUsage?: OnUsage;
}): Promise<ImportPlanT | null> {
  const text =
    `Sheets (headers + sample rows):\n${JSON.stringify(input.sheets)}\n\n` +
    `Existing sections: ${JSON.stringify(input.existing)}`;
  return structured(ImportPlan, IMPORT_SYSTEM, [{ type: "text", text }], env.effortHeavy, "import-plan",
    { normalize: normalizeImport, onUsage: input.onUsage });
}
