import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  Message,
  Part,
  StopReason,
} from "./types";

/**
 * Claude adapter (Messages API).
 * - Tools + system prompt form one cache prefix shared by all merchants; the conversation is auto-cached.
 * - Adaptive thinking with an effort level; thinking blocks are replayed unchanged via `native`.
 * - Refusals are surfaced as stop "refusal" so the agent can escalate or fall back to another provider.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic(); // reads ANTHROPIC_API_KEY
  }

  async complete(
    model: string,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
    if (req.context) system.push({ type: "text", text: req.context });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens,
      system,
      messages: req.messages.map((m) => toAnthropicMessage(m, model)),
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
      output_config: {
        effort: req.effort ?? "low",
        ...(req.jsonSchema
          ? { format: { type: "json_schema", schema: req.jsonSchema.schema } }
          : {}),
      },
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    };

    const res = await this.client.messages.create(params);
    return {
      provider: this.name,
      model,
      parts: fromAnthropicContent(res.content),
      native: res.content,
      stop: mapStop(res.stop_reason),
      usage: {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function mapStop(stop: Anthropic.StopReason | null): StopReason {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function toAnthropicMessage(
  m: Message,
  model: string,
): Anthropic.MessageParam {
  if (
    m.role === "assistant" &&
    m.native?.provider === "anthropic" &&
    m.native.model === model
  ) {
    return {
      role: "assistant",
      content: m.native.content as Anthropic.ContentBlockParam[],
    };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  for (const p of m.parts) {
    switch (p.type) {
      case "text":
        if (p.text) content.push({ type: "text", text: p.text });
        break;
      case "image":
        content.push({
          type: "image",
          source: { type: "base64", media_type: p.mediaType, data: p.data },
        });
        break;
      case "tool_call":
        content.push({
          type: "tool_use",
          id: p.id,
          name: p.name,
          input: p.input,
        });
        break;
      case "tool_result":
        content.push({
          type: "tool_result",
          tool_use_id: p.toolCallId,
          content: p.content,
          is_error: p.isError,
        });
        break;
    }
  }
  return { role: m.role, content };
}

export function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
): Part[] {
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "tool_use")
      parts.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    // thinking / redacted_thinking blocks stay in `native` only
  }
  return parts;
}
