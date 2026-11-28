import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

/** Lightweight polling endpoint for the connect step. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const linkedCount = await db.merchantUser.count({
    where: { shop: { shopDomain: session.shop }, revokedAt: null },
  });
  return { linkedCount };
};
