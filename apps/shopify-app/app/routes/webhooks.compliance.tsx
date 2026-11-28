import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * Mandatory privacy compliance webhooks for public apps.
 * authenticate.webhook verifies the HMAC and returns 401 for invalid requests.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.info(`[compliance] ${topic} for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // We store no customer records: abandoned checkout data is fetched live and never persisted.
      // If that changes, export the customer's data here and send it to the merchant.
      break;
    case "CUSTOMERS_REDACT":
      // Nothing customer-specific is stored. See note above.
      break;
    case "SHOP_REDACT": {
      // Sent 48 hours after uninstall: remove everything we hold for the shop.
      await db.shop.deleteMany({ where: { shopDomain: shop } }); // cascades to all shop data
      await db.session.deleteMany({ where: { shop } });
      break;
    }
    default:
      break;
  }
  return new Response();
};
