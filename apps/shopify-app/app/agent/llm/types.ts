/**
 * Provider-neutral types for the agent. Every provider adapter (Claude, OpenAI, ...) converts between
 * these and its own API, so the agent loop, tools and storage never depend on one vendor.
 */

export type ProviderName = "anthropic" | "openai";

export type Part =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      data: string; /* base64 */
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
  /**
   * The provider's own representation of an assistant turn (for example Claude's thinking blocks),
   * replayed unchanged when the same provider and model continue the conversation.
   */
  native?: { provider: ProviderName; model: string; content: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: object). */
  inputSchema: Record<string, unknown>;
}

export type Effort = "low" | "medium" | "high";

export interface CompletionRequest {
  /** Stable instructions shared by every merchant: cached where the provider supports it. */
  system: string;
  /** Per-merchant or per-turn context placed after the cached prefix. */
  context?: string;
  tools: ToolDef[];
  messages: Message[];
  maxTokens: number;
  effort?: Effort;
  /** Ask for a JSON object matching this schema instead of free text (no tools). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export type StopReason =
  "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number; // uncached input
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionResult {
  provider: ProviderName;
  model: string;
  parts: Part[];
  native: unknown;
  stop: StopReason;
  usage: Usage;
}

export interface LlmProvider {
  readonly name: ProviderName;
  complete(
    model: string,
    request: CompletionRequest,
  ): Promise<CompletionResult>;
}

/** "provider:model", e.g. "anthropic:claude-haiku-5-5" or "openai:gpt-5-mini". */
export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export function parseModelRef(value: string): ModelRef {
  const index = value.indexOf(":");
  if (index <= 0)
    throw new Error(`Model must look like "provider:model", got "${value}"`);
  const provider = value.slice(0, index) as ProviderName;
  if (provider !== "anthropic" && provider !== "openai")
    throw new Error(`Unknown LLM provider "${provider}"`);
  return { provider, model: value.slice(index + 1) };
}

export function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}
