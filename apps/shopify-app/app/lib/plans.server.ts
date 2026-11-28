import db from "../db.server";
import type { PlanId } from "./plans";
import { planFromSubscriptionName } from "./plans";

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

/**
 * Reads the active Shopify subscription (Managed Pricing) and caches the plan on the Shop row,
 * so background jobs can check features without an admin session.
 * PLAN_OVERRIDE=solo|group forces a plan in development.
 */
export async function refreshPlan(
  shopId: string,
  graphql: AdminGraphql,
): Promise<PlanId> {
  const override = process.env.PLAN_OVERRIDE as PlanId | undefined;
  if (override === "solo" || override === "group" || override === "none") {
    await db.shop.update({
      where: { id: shopId },
      data: { plan: override, planCheckedAt: new Date() },
    });
    return override;
  }
  try {
    const res = await graphql(`
      #graphql
      query ActivePlan {
        currentAppInstallation {
          activeSubscriptions {
            name
            status
          }
        }
      }
    `);
    const json = (await res.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: { name: string; status: string }[];
        };
      };
    };
    const active = json.data?.currentAppInstallation?.activeSubscriptions?.find(
      (s) => s.status === "ACTIVE",
    );
    const plan = planFromSubscriptionName(active?.name);
    await db.shop.update({
      where: { id: shopId },
      data: { plan, planCheckedAt: new Date() },
    });
    return plan;
  } catch (error) {
    console.warn("[plans] could not read subscription", error);
    const shop = await db.shop.findUnique({
      where: { id: shopId },
      select: { plan: true },
    });
    return (shop?.plan as PlanId) ?? "none";
  }
}

/** Plan check is cheap but not free; refresh at most every 10 minutes from admin page loads. */
export async function currentPlan(
  shop: { id: string; plan: string; planCheckedAt: Date | null },
  graphql: AdminGraphql,
) {
  const fresh =
    shop.planCheckedAt &&
    Date.now() - shop.planCheckedAt.getTime() < 10 * 60 * 1000;
  if (fresh && !process.env.PLAN_OVERRIDE) return shop.plan as PlanId;
  return refreshPlan(shop.id, graphql);
}
