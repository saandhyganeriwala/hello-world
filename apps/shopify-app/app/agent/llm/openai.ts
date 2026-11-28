import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  LlmProvider,
  Message,
  Part,
  StopReason,
} from "./types";

/**
 * OpenAI adapter (Chat Completions with function calling).
 * OpenAI caches long shared prefixes automatically; `prompt_cache_key` groups requests that share our
 * system prompt + tools so they land on the same cache.
 * Set OPENAI_REASONING_EFFORT for reasoning models (for example "low"); leave it unset for others.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI(); // reads OPENAI_API_KEY
  }

  async complete(
    model: string,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
    ];
    if (req.context) messages.push({ role: "system", content: req.context });
    for (const m of req.messages) messages.push(...toOpenAIMessages(m));

    const effortEnv = process.env.OPENAI_REASONING_EFFORT;
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      max_completion_tokens: req.maxTokens,
      prompt_cache_key: "storemate-agent-v1",
      ...(effortEnv
        ? {
            reasoning_effort: (req.effort ??
              effortEnv) as OpenAI.ReasoningEffort,
          }
        : {}),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      ...(req.jsonSchema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: req.jsonSchema.name,
                schema: req.jsonSchema.schema,
              },
            },
          }
        : {}),
    };

    const res = await this.client.chat.completions.create(params);
    const choice = res.choices[0];
    const parts: Part[] = [];
    if (choice?.message?.content)
      parts.push({ type: "text", text: choice.message.content });
    for (const call of choice?.message?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      let input: Record<string, unknown> = {};
      try {
        input = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};
      } catch {
        input = { __invalid_json: call.function.arguments };
      }
      parts.push({
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        input,
      });
    }
    if (choice?.message?.refusal)
      parts.push({ type: "text", text: choice.message.refusal });

    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      provider: this.name,
      model,
      parts,
      native: choice?.message ?? null,
      stop: mapFinish(choice?.finish_reason, Boolean(choice?.message?.refusal)),
      usage: {
        inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
        outputTokens: res.usage?.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}

function mapFinish(
  reason: string | null | undefined,
  refused: boolean,
): StopReason {
  if (refused) return "refusal";
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

export function toOpenAIMessages(
  m: Message,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (m.role === "assistant") {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const toolCalls = m.parts
      .filter(
        (p): p is Extract<Part, { type: "tool_call" }> =>
          p.type === "tool_call",
      )
      .map((p) => ({
        id: p.id,
        type: "function" as const,
        function: { name: p.name, arguments: JSON.stringify(p.input) },
      }));
    return [
      {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  // A user turn may hold tool results (one OpenAI "tool" message each) plus text/images.
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [];
  for (const p of m.parts) {
    if (p.type === "tool_result") {
      out.push({
        role: "tool",
        tool_call_id: p.toolCallId,
        content: p.isError ? `ERROR: ${p.content}` : p.content,
      });
    } else if (p.type === "text") {
      userContent.push({ type: "text", text: p.text });
    } else if (p.type === "image") {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${p.mediaType};base64,${p.data}` },
      });
    }
  }
  if (userContent.length) out.push({ role: "user", content: userContent });
  return out;
}
