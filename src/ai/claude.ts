import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
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

async function structured<S extends z.ZodType>(
  schema: S, system: string, content: Anthropic.Beta.BetaContentBlockParam[], effort: Effort, label: string,
): Promise<z.infer<S> | null> {
  if (!client) throw new AiUnavailable("ANTHROPIC_API_KEY is not set");
  const params: any = {
    model: env.claudeModel,
    max_tokens: 16000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  };
  if (useFallbacks) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }

  const started = Date.now();
  let res: Awaited<ReturnType<typeof client.beta.messages.parse>>;
  try {
    res = await client.beta.messages.parse(params);
  } catch (e) {
    if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
      console.warn("[ai] server-side fallback not accepted; continuing without it");
      useFallbacks = false;
      return structured(schema, system, content, effort, label);
    }
    throw e;
  }
  const u = res.usage as any;
  console.log(JSON.stringify({
    ai: label, model: res.model, ms: Date.now() - started, stop: res.stop_reason,
    in: u?.input_tokens, out: u?.output_tokens, cacheRead: u?.cache_read_input_tokens, cacheWrite: u?.cache_creation_input_tokens,
  }));
  if (res.stop_reason === "refusal") {
    console.warn("[ai] refusal", (res as any).stop_details?.category);
    return null;
  }
  return (res.parsed_output as z.infer<S> | null) ?? null;
}

export type Snapshot = {
  sections: { name: string; kind: string; fields: string[]; views: { name: unknown; type: unknown }[] }[];
  records: { id: string; section: string; title: string; fields: Record<string, string> }[];
};

export async function understand(input: {
  text: string; snapshot: Snapshot; contextRecordId?: string | null; images?: ImageInput[];
  viewing?: { section: string; view: unknown } | null;
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
  return structured(Understanding, UNDERSTAND_SYSTEM, content, imgs.length ? env.effortHeavy : env.effortChat, imgs.length ? "understand+image" : "understand");
}

export async function planImport(input: {
  sheets: { sheet: string; headers: string[]; sample: Record<string, string>[] }[];
  existing: { name: string; kind: string }[];
}): Promise<ImportPlanT | null> {
  const text =
    `Sheets (headers + sample rows):\n${JSON.stringify(input.sheets)}\n\n` +
    `Existing sections: ${JSON.stringify(input.existing)}`;
  return structured(ImportPlan, IMPORT_SYSTEM, [{ type: "text", text }], env.effortHeavy, "import-plan");
}
