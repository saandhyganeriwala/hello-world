import db from "../db.server";
import { config, whatsappSendingEnabled } from "./config.server";
import { LINK_CODE_TTL_MS, generateLinkCode, linkMessageText, waMeLink } from "./link-code";

/** Returns a usable link code for the shop, reusing one with at least 2 minutes left. */
export async function getOrCreateLinkCode(shopId: string) {
  const now = Date.now();
  const existing = await db.linkCode.findFirst({
    where: { shopId, usedAt: null, expiresAt: { gt: new Date(now + 2 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.linkCode.create({
        data: { code: generateLinkCode(), shopId, expiresAt: new Date(now + LINK_CODE_TTL_MS) },
      });
    } catch {
      // Primary key collision: try another code.
    }
  }
  throw new Error("Could not create a link code");
}

export function connectLinks(code: string) {
  const text = linkMessageText(code);
  const number = config.whatsapp.displayNumber;
  return {
    text,
    displayNumber: number,
    url: number ? waMeLink(number, text) : null,
    chatUrl: number ? `https://wa.me/${number.replace(/\D/g, "")}` : null,
  };
}

export type LinkResult =
  | { ok: true; shopId: string; shopName: string | null; alreadyLinked: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Binds a WhatsApp number to the shop that issued the code.
 * A number manages one shop at a time: linking to a new shop revokes older bindings.
 */
export async function consumeLinkCode(code: string, waId: string, displayName?: string): Promise<LinkResult> {
  const link = await db.linkCode.findUnique({ where: { code }, include: { shop: true } });
  if (!link || link.shop.uninstalledAt) return { ok: false, reason: "invalid" };
  if (link.usedAt) return { ok: false, reason: "used" };
  if (link.expiresAt < new Date()) return { ok: false, reason: "expired" };

  return db.$transaction(async (tx) => {
    await tx.linkCode.update({ where: { code }, data: { usedAt: new Date(), usedByWaId: waId } });
    await tx.merchantUser.updateMany({
      where: { waId, revokedAt: null, NOT: { shopId: link.shopId } },
      data: { revokedAt: new Date() },
    });
    const ownerExists = await tx.merchantUser.count({
      where: { shopId: link.shopId, revokedAt: null, role: "owner", NOT: { waId } },
    });
    const existing = await tx.merchantUser.findUnique({
      where: { shopId_waId: { shopId: link.shopId, waId } },
    });
    await tx.merchantUser.upsert({
      where: { shopId_waId: { shopId: link.shopId, waId } },
      create: { shopId: link.shopId, waId, displayName, role: ownerExists ? "staff" : "owner" },
      update: { revokedAt: null, displayName: displayName ?? undefined, linkedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: {
        shopId: link.shopId,
        actor: "merchant",
        waId,
        tool: "link_whatsapp",
        summary: "Connected a WhatsApp number",
      },
    });
    return {
      ok: true as const,
      shopId: link.shopId,
      shopName: link.shop.name,
      alreadyLinked: Boolean(existing && !existing.revokedAt),
    };
  });
}

/** Finds the shop a WhatsApp number currently manages. */
export function findActiveMerchant(waId: string) {
  return db.merchantUser.findFirst({
    where: { waId, revokedAt: null, shop: { uninstalledAt: null } },
    include: { shop: true },
    orderBy: { linkedAt: "desc" },
  });
}

/**
 * Sends a plain text WhatsApp message. Without Meta credentials (local development) it only logs,
 * so the rest of the app works before the WhatsApp number is set up.
 */
export async function sendText(to: string, body: string, shopId?: string | null) {
  if (!whatsappSendingEnabled()) {
    console.info(`[whatsapp:mock] to=${to} body=${JSON.stringify(body)}`);
    return { mocked: true as const };
  }
  const { graphVersion, phoneNumberId, accessToken } = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: true } }),
  });
  const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: unknown };
  if (!res.ok) {
    console.error("[whatsapp] send failed", res.status, JSON.stringify(json.error ?? json));
    return { mocked: false as const, ok: false as const };
  }
  const id = json.messages?.[0]?.id;
  if (id) {
    await db.waMessage
      .create({ data: { waMessageId: id, direction: "out", shopId: shopId ?? null, waId: to, type: "text", body, payload: {} } })
      .catch(() => undefined);
  }
  return { mocked: false as const, ok: true as const };
}

export function connectedWelcome(shopName: string | null) {
  return (
    `Connected to ${shopName ?? "your store"}.\n\n` +
    "Try one of these:\n" +
    "- Send product photos with a price to create a product\n" +
    "- \"How were sales this week?\"\n" +
    "- \"Free shipping above 999\"\n\n" +
    "I'll always ask before publishing or changing prices, shipping or discounts."
  );
}

export const NOT_LINKED_REPLY =
  "This number isn't connected to a store yet. Open Storemate in your Shopify admin and tap Connect WhatsApp.";

export const LINK_FAILED_REPLY: Record<"invalid" | "expired" | "used", string> = {
  invalid: "That connection code isn't valid. Open Storemate in your Shopify admin to get a new one.",
  expired: "That connection code has expired. Open Storemate in your Shopify admin to get a new one.",
  used: "That connection code was already used. Open Storemate in your Shopify admin to get a new one.",
};
