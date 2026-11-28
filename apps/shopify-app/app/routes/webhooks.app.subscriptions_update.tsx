import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { refreshPlan } from "../lib/plans.server";

/** Keeps the cached plan in sync when the merchant subscribes, upgrades, downgrades or cancels. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await authenticate.webhook(request);
  const record = await db.shop.findUnique({ where: { shopDomain: shop } });
  if (record && admin) await refreshPlan(record.id, admin.graphql);
  return new Response();
};
