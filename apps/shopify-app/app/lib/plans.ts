/**
 * Plans and what each one includes. The single source of truth for feature gating in the admin,
 * the agent's tools and the scheduler.
 */
export type PlanId = "none" | "solo" | "group";

export interface PlanInfo {
  id: Exclude<PlanId, "none">;
  name: string;
  priceUsd: number;
  tagline: string;
  features: string[];
  /** WhatsApp numbers that can chat with the assistant one-to-one */
  maxDirectNumbers: number;
  group: boolean;
  summaries: boolean;
  checkoutRecovery: boolean;
  /** Monthly assistant (LLM) budget in USD before graceful degradation */
  llmBudgetUsd: number;
}

export const PLANS: Record<Exclude<PlanId, "none">, PlanInfo> = {
  solo: {
    id: "solo",
    name: "Solo",
    priceUsd: Number(process.env.PLAN_SOLO_PRICE_USD ?? "5.99"),
    tagline: "Run your store from your own WhatsApp.",
    features: [
      "One WhatsApp number",
      "Add products from photos",
      "Prices, stock, shipping, discounts and banners",
      "Ask about sales any time",
    ],
    maxDirectNumbers: 1,
    group: false,
    summaries: false,
    checkoutRecovery: false,
    llmBudgetUsd: Number(process.env.PLAN_SOLO_LLM_BUDGET_USD ?? "2.5"),
  },
  group: {
    id: "group",
    name: "Group",
    priceUsd: Number(process.env.PLAN_GROUP_PRICE_USD ?? "9.99"),
    tagline: "Your whole team in one WhatsApp group with Storemate.",
    features: [
      "Everything in Solo",
      "A WhatsApp group for your team (up to 8 people)",
      "Up to 8 numbers can also chat one-to-one",
      "Daily or weekly sales summaries",
      "Abandoned checkout follow-up drafts",
    ],
    maxDirectNumbers: 8,
    group: true,
    summaries: true,
    checkoutRecovery: true,
    llmBudgetUsd: Number(process.env.PLAN_GROUP_LLM_BUDGET_USD ?? "4"),
  },
};

/** Meta's limit for groups created through the Cloud API Groups API. */
export const GROUP_MAX_PARTICIPANTS = 8;

/** Maps a Shopify subscription name to a plan. Plan names are set in the Partner Dashboard. */
export function planFromSubscriptionName(
  name: string | null | undefined,
): PlanId {
  if (!name) return "none";
  const lower = name.toLowerCase();
  if (lower.includes("group") || lower.includes("team")) return "group";
  if (
    lower.includes("solo") ||
    lower.includes("starter") ||
    lower.includes("basic")
  )
    return "solo";
  return "solo";
}

export function planInfo(plan: PlanId): PlanInfo | null {
  return plan === "none" ? null : PLANS[plan];
}

export type Feature = "group" | "summaries" | "checkoutRecovery";

export function hasFeature(plan: PlanId, feature: Feature): boolean {
  const info = planInfo(plan);
  return Boolean(info && info[feature]);
}

export function maxDirectNumbers(plan: PlanId): number {
  return planInfo(plan)?.maxDirectNumbers ?? 1;
}

export function llmBudgetUsd(plan: PlanId): number {
  return planInfo(plan)?.llmBudgetUsd ?? PLANS.solo.llmBudgetUsd;
}
