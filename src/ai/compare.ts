// What the same AI calls would have cost on OpenAI's GPT models — an estimate for the admin page.
//
// For each recorded call we know Claude's token counts. On a GPT model:
//   • fresh input and Claude's cache-write tokens are billed at the normal input price (OpenAI caches prompts
//     automatically and charges nothing extra to write the cache),
//   • Claude's cache-read tokens are billed at OpenAI's cached-input price,
//   • output tokens (including reasoning) at the output price,
//   • times GPT_TOKEN_RATIO: GPT tokens per Claude token for the same text (tokenizers differ; default 1).
// Voice transcription isn't a Claude call, so it's counted at its real cost in every column.
//
// Prices are USD per million tokens. OpenAI's own pricing pages couldn't be reached when these were added
// (Nov 2026), so check them and override with GPT_PRICES_JSON if they differ, e.g.
//   GPT_PRICES_JSON=[{"id":"gpt-5.5-mini","label":"GPT-5.5 mini","in":0.9,"cachedIn":0.09,"out":5.5}]
export type GptPrice = { id: string; label: string; in: number; cachedIn: number; out: number; note?: string; source?: string };

const DEFAULT_GPT_PRICES: GptPrice[] = [
  { id: "gpt-5.5", label: "GPT-5.5", in: 5, cachedIn: 0.5, out: 30, note: "flagship",
    source: "OpenAI model page (developers.openai.com/api/docs/models/gpt-5.5)" },
  { id: "gpt-5.5-mini", label: "GPT-5.5 mini", in: 0.9, cachedIn: 0.09, out: 5.5, note: "closest like-for-like",
    source: "calcis.dev (third-party); cached input assumed 10% of input" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", in: 0.2, cachedIn: 0.02, out: 1.2, note: "budget",
    source: "openrouter.ai (third-party)" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", in: 0.1, cachedIn: 0.01, out: 0.5, note: "cheapest",
    source: "openrouter.ai / benchlm.ai (third-party); cached input assumed 10% of input" },
];

function load(): GptPrice[] {
  try {
    const j = JSON.parse(process.env.GPT_PRICES_JSON || "null");
    if (Array.isArray(j) && j.length) return j.filter((p) => p && p.id && [p.in, p.cachedIn, p.out].every((n) => typeof n === "number"));
  } catch { /* fall back to the defaults */ }
  return DEFAULT_GPT_PRICES;
}
export const GPT_PRICES = load();
export const GPT_TOKEN_RATIO = Number(process.env.GPT_TOKEN_RATIO || 1) || 1;

export type TokenSums = { label: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };

/** Estimated USD cost of these calls on a GPT model. */
export function gptCostUsd(t: TokenSums, p: GptPrice) {
  if (t.label === "transcribe") return t.costUsd; // not a Claude call
  return ((t.input + t.cacheWrite) * p.in + t.cacheRead * p.cachedIn + t.output * p.out) * GPT_TOKEN_RATIO / 1e6;
}
