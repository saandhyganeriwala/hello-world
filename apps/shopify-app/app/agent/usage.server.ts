import db from "../db.server";
import { llmBudgetUsd, type PlanId } from "../lib/plans";
import { startOfMonth } from "../lib/shop.server";
import type { CompletionResult } from "./llm";

export async function recordUsage(
  shopId: string,
  episodeId: string | null,
  purpose: string,
  result: CompletionResult,
  cost: number,
) {
  await db.llmUsage.create({
    data: {
      shopId,
      episodeId,
      purpose,
      model: `${result.provider}:${result.model}`,
      inputTokens: result.usage.inputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: cost,
    },
  });
}

export type BudgetState = "ok" | "soft" | "hard";

/** ok below 80% of the plan budget, soft (no escalation, no premium work) to 100%, hard above. */
export async function budgetState(
  shopId: string,
  plan: PlanId,
): Promise<{ state: BudgetState; spent: number; limit: number }> {
  const agg = await db.llmUsage.aggregate({
    where: { shopId, createdAt: { gte: startOfMonth() } },
    _sum: { costUsd: true },
  });
  const spent = Number(agg._sum.costUsd ?? 0);
  const limit = llmBudgetUsd(plan);
  return {
    state: spent >= limit ? "hard" : spent >= limit * 0.8 ? "soft" : "ok",
    spent,
    limit,
  };
}
