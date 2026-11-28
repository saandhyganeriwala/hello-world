import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Stop WhatsApp access immediately. All remaining data is deleted on shop/redact.
  const record = await db.shop.findUnique({ where: { shopDomain: shop } });
  if (record) {
    const now = new Date();
    await db.$transaction([
      db.shop.update({ where: { id: record.id }, data: { uninstalledAt: now, setupDismissedAt: null } }),
      db.merchantUser.updateMany({ where: { shopId: record.id, revokedAt: null }, data: { revokedAt: now } }),
      db.linkCode.deleteMany({ where: { shopId: record.id } }),
      db.pendingAction.updateMany({ where: { shopId: record.id, status: "pending" }, data: { status: "expired" } }),
    ]);
  }

  return new Response();
};
