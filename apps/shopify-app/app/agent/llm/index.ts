import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  ModelRef,
  ProviderName,
  Usage,
} from "./types";
import { parseModelRef } from "./types";

export * from "./types";

/**
 * Which model handles which job. Change these environment variables to switch provider or model,
 * e.g. LLM_AGENT="openai:gpt-5-mini". No code change is needed.
 */
export type Route = "agent" | "escalation" | "listing" | "summary";

const DEFAULTS: Record<Route, string> = {
  agent: "anthropic:claude-haiku-5-5",
  escalation: "anthropic:claude-sonnet-5-5",
  listing: "anthropic:claude-haiku-5-5",
  summary: "anthropic:claude-haiku-5-5",
};

const ENV_KEYS: Record<Route, string> = {
  agent: "LLM_AGENT",
  escalation: "LLM_ESCALATION",
  listing: "LLM_LISTING",
  summary: "LLM_SUMMARY",
};

export function modelFor(route: Route): ModelRef {
  return parseModelRef(process.env[ENV_KEYS[route]] || DEFAULTS[route]);
}

/** Optional second choice used when the primary provider errors or refuses, e.g. "openai:gpt-5-mini". */
export function fallbackModel(): ModelRef | null {
  const value = process.env.LLM_FALLBACK;
  return value ? parseModelRef(value) : null;
}

const providers = new Map<ProviderName, LlmProvider>();

export function providerFor(name: ProviderName): LlmProvider {
  let provider = providers.get(name);
  if (!provider) {
    provider =
      name === "anthropic" ? new AnthropicProvider() : new OpenAIProvider();
    providers.set(name, provider);
  }
  return provider;
}

/** For tests: replace a provider with a fake. */
export function setProvider(provider: LlmProvider) {
  providers.set(provider.name, provider);
}

export async function complete(
  ref: ModelRef,
  request: CompletionRequest,
): Promise<CompletionResult> {
  return providerFor(ref.provider).complete(ref.model, request);
}

/**
 * Calls the model for a route; on an API error or refusal, retries once on LLM_FALLBACK (if set).
 */
export async function completeWithFallback(
  route: Route,
  request: CompletionRequest,
) {
  const primary = modelFor(route);
  try {
    const result = await complete(primary, request);
    if (result.stop !== "refusal") return result;
    const fb = fallbackModel();
    if (!fb || sameModel(fb, primary)) return result;
    return await complete(fb, request);
  } catch (error) {
    const fb = fallbackModel();
    if (!fb || sameModel(fb, primary)) throw error;
    console.warn(
      `[llm] ${primary.provider}:${primary.model} failed, falling back to ${fb.provider}:${fb.model}`,
      error,
    );
    return complete(fb, request);
  }
}

const sameModel = (a: ModelRef, b: ModelRef) =>
  a.provider === b.provider && a.model === b.model;

/**
 * USD per million tokens. Defaults cover the models we route to; override or add with
 * LLM_PRICES_JSON='{"openai:gpt-5-mini":{"input":0.25,"output":2,"cacheRead":0.025}}'.
 * Check the providers' pricing pages before relying on these numbers.
 */
interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
const DEFAULT_PRICES: Record<string, Price> = {
  "anthropic:claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  },
  "anthropic:claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  "anthropic:claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
  },
  "openai:gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "openai:gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
};

let priceTable: Record<string, Price> | null = null;
function prices(): Record<string, Price> {
  if (!priceTable) {
    let extra: Record<string, Price> = {};
    try {
      extra = process.env.LLM_PRICES_JSON
        ? JSON.parse(process.env.LLM_PRICES_JSON)
        : {};
    } catch {
      console.warn("[llm] LLM_PRICES_JSON is not valid JSON; ignoring");
    }
    priceTable = { ...DEFAULT_PRICES, ...extra };
  }
  return priceTable;
}

export function costUsd(
  provider: ProviderName,
  model: string,
  usage: Usage,
): number {
  const price = prices()[`${provider}:${model}`];
  if (!price) {
    console.warn(
      `[llm] no price for ${provider}:${model}; cost logged as 0. Add it to LLM_PRICES_JSON.`,
    );
    return 0;
  }
  const perToken = (rate: number | undefined, tokens: number) =>
    ((rate ?? 0) * tokens) / 1_000_000;
  return (
    perToken(price.input, usage.inputTokens) +
    perToken(price.output, usage.outputTokens) +
    perToken(price.cacheRead ?? price.input, usage.cacheReadTokens) +
    perToken(price.cacheWrite ?? price.input, usage.cacheWriteTokens)
  );
}
