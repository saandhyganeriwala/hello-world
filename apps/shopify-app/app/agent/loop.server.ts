import type { Prisma } from "@prisma/client";
import db from "../db.server";
import {
  completeWithFallback,
  costUsd,
  textOf,
  type Message,
  type Part,
  type Route,
} from "./llm";
import { SYSTEM_PROMPT } from "./prompt";
import { modelTools } from "./tools/definitions";
import { runTool, type ToolContext } from "./tools/handlers.server";
import { budgetState, recordUsage } from "./usage.server";

const MAX_TOOL_ROUNDS = 8;
const EPISODE_IDLE_MS = 30 * 60 * 1000;
const EPISODE_MAX_MESSAGES = 40;

/** Returns the open episode for a conversation, or starts a new one (carrying a short summary forward). */
export async function openEpisode(shopId: string, conversationKey: string) {
  const current = await db.episode.findFirst({
    where: { shopId, conversationKey, status: "open" },
    orderBy: { updatedAt: "desc" },
  });
  if (current) {
    const messages = current.messages as unknown as Message[];
    const fresh =
      Date.now() - current.updatedAt.getTime() < EPISODE_IDLE_MS &&
      messages.length < EPISODE_MAX_MESSAGES;
    if (fresh) return { episode: current, previousSummary: current.summary };
    await db.episode.update({
      where: { id: current.id },
      data: { status: "closed", summary: summarize(messages) },
    });
  }
  const previous = current
    ? summarize(current.messages as unknown as Message[])
    : null;
  const episode = await db.episode.create({
    data: { shopId, conversationKey, summary: previous },
  });
  return { episode, previousSummary: previous };
}

/** Cheap carry-over summary without an extra model call: the last exchange in plain text. */
function summarize(messages: Message[]): string | null {
  const texts = messages
    .map((m) => ({ role: m.role, text: textOf(m.parts) }))
    .filter((m) => m.text)
    .slice(-4)
    .map(
      (m) =>
        `${m.role === "user" ? "Merchant" : "You"}: ${m.text.slice(0, 200)}`,
    );
  return texts.length ? texts.join(" | ") : null;
}

export interface TurnResult {
  reply: string;
  usedModel?: string;
}

/**
 * One assistant turn: call the model, run tools, repeat until it answers (max 8 tool rounds).
 * Conversation history is append-only within an episode (keeps prompt caching effective and
 * replayed thinking blocks valid).
 */
export async function runAgentTurn(opts: {
  ctx: ToolContext;
  episodeId: string;
  userParts: Part[];
  context: string;
}): Promise<TurnResult> {
  const { ctx } = opts;
  const episode = await db.episode.findUniqueOrThrow({
    where: { id: opts.episodeId },
  });
  const messages = [
    ...(episode.messages as unknown as Message[]),
    { role: "user", parts: opts.userParts } as Message,
  ];
  let route = episode.route as Route;
  let escalations = episode.escalations;

  const budget = await budgetState(ctx.shop.id, ctx.plan);
  if (budget.state === "hard") {
    return {
      reply:
        "You've used this month's assistant allowance for your plan. It resets at the start of next month. " +
        "You can still make changes in Shopify admin, or upgrade from the Plan page in the Storemate app.",
    };
  }
  if (budget.state === "soft" && route === "escalation") route = "agent";

  let reply = "";
  let usedModel: string | undefined;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await completeWithFallback(route, {
        system: SYSTEM_PROMPT,
        context: opts.context,
        tools: modelTools(),
        messages,
        maxTokens: 4096,
        effort: route === "escalation" ? "medium" : "low",
      });
      usedModel = `${result.provider}:${result.model}`;
      await recordUsage(
        ctx.shop.id,
        episode.id,
        `agent:${route}`,
        result,
        costUsd(result.provider, result.model, result.usage),
      );

      if (result.stop === "refusal") {
        if (route === "agent" && budget.state === "ok" && escalations < 1) {
          route = "escalation";
          escalations++;
          continue;
        }
        reply = "Sorry, I can't help with that request.";
        break;
      }

      messages.push({
        role: "assistant",
        parts: result.parts,
        native: {
          provider: result.provider,
          model: result.model,
          content: result.native,
        },
      });
      const calls = result.parts.filter(
        (p): p is Extract<Part, { type: "tool_call" }> =>
          p.type === "tool_call",
      );
      if (!calls.length || result.stop !== "tool_use") {
        reply = textOf(result.parts);
        break;
      }

      const outcomes = await Promise.all(
        calls.map((call) => runTool(ctx, call.name, call.input)),
      );
      messages.push({
        role: "user",
        parts: calls.map((call, i) => ({
          type: "tool_result" as const,
          toolCallId: call.id,
          content: outcomes[i].content,
          isError: outcomes[i].isError,
        })),
      });

      if (
        ctx.escalate &&
        route === "agent" &&
        budget.state === "ok" &&
        escalations < 1
      ) {
        route = "escalation";
        escalations++;
        ctx.escalate = undefined;
      }
      if (round === MAX_TOOL_ROUNDS - 1) {
        reply =
          "That took more steps than expected. I've saved progress. Reply *continue* to keep going.";
      }
    }
  } finally {
    await db.episode.update({
      where: { id: episode.id },
      data: {
        messages: messages as unknown as Prisma.InputJsonValue,
        route,
        escalations,
      },
    });
  }
  return { reply: reply || "Done.", usedModel };
}
