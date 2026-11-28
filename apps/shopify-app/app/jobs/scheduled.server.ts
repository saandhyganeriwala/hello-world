import db from "../db.server";
import { ShopClient } from "../agent/shopify/client.server";
import { fetchAbandonedCheckouts } from "../agent/checkouts.server";
import { formatSummaryMessage, periodStats } from "../agent/summaries.server";
import { addDays, formatMoney, localNow } from "../agent/util";
import { config } from "../lib/config.server";
import { hasFeature, type PlanId } from "../lib/plans";
import {
  sendTemplate,
  sendText,
  type Destination,
} from "../lib/whatsapp-api.server";
import { enqueue } from "./queue.server";

/**
 * Daily/weekly sales summaries and the abandoned checkout digest (Group plan features).
 * The scheduler runs every few minutes, finds shops whose local send hour has come, and enqueues one job
 * per shop; lastSummaryAt/lastDigestAt stop duplicates.
 */
export async function scheduleDueUpdates(now = new Date()) {
  const shops = await db.shop.findMany({
    where: { uninstalledAt: null, plan: "group" },
    include: { settings: true },
  });
  for (const shop of shops) {
    const s = shop.settings;
    if (!s) continue;
    const local = localNow(shop.ianaTimezone ?? "Asia/Kolkata", now);
    if (local.hour < s.summaryHour) continue;
    const sentToday = (at: Date | null) =>
      at &&
      localNow(shop.ianaTimezone ?? "Asia/Kolkata", at).date === local.date;

    const summaryDue =
      hasFeature(shop.plan as PlanId, "summaries") &&
      (s.summaryFrequency === "daily" ||
        (s.summaryFrequency === "weekly" &&
          local.weekday === s.weeklySummaryDay)) &&
      !sentToday(s.lastSummaryAt);
    if (summaryDue) {
      await db.shopSettings.update({
        where: { shopId: shop.id },
        data: { lastSummaryAt: now },
      });
      await enqueue(
        "summary",
        { shopId: shop.id },
        { conversationKey: `shop:${shop.id}:updates` },
      );
    }
    const digestDue =
      hasFeature(shop.plan as PlanId, "checkoutRecovery") &&
      s.checkoutDigestEnabled &&
      !sentToday(s.lastDigestAt);
    if (digestDue) {
      await db.shopSettings.update({
        where: { shopId: shop.id },
        data: { lastDigestAt: now },
      });
      await enqueue(
        "checkout_digest",
        { shopId: shop.id },
        { conversationKey: `shop:${shop.id}:updates` },
      );
    }
  }
}

/** Where updates go: the team group when it exists and is chosen, otherwise the owner's chat. */
async function updatesDestination(shopId: string, preference: string) {
  if (preference === "group") {
    const group = await db.storeGroup.findUnique({ where: { shopId } });
    if (group?.status === "active" && group.groupId) {
      const open = Boolean(
        group.lastInboundAt &&
        Date.now() - group.lastInboundAt.getTime() < 23 * 3600_000,
      );
      return {
        dest: { kind: "group", groupId: group.groupId } as Destination,
        windowOpen: open,
      };
    }
  }
  const owner = await db.merchantUser.findFirst({
    where: { shopId, revokedAt: null, role: "owner" },
  });
  if (!owner) return null;
  const open = Boolean(
    owner.lastInboundAt &&
    Date.now() - owner.lastInboundAt.getTime() < 23 * 3600_000,
  );
  return {
    dest: { kind: "dm", waId: owner.waId } as Destination,
    windowOpen: open,
  };
}

export async function runSummaryJob(shopId: string) {
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    include: { settings: true },
  });
  if (!hasFeature(shop.plan as PlanId, "summaries") || !shop.settings) return;
  const target = await updatesDestination(
    shop.id,
    shop.settings.updatesDestination,
  );
  if (!target) return;

  const tz = shop.ianaTimezone ?? "Asia/Kolkata";
  const today = localNow(tz).date;
  const daily = shop.settings.summaryFrequency === "daily";
  const from = addDays(today, daily ? -1 : -7);
  const prevFrom = addDays(from, daily ? -1 : -7);
  const api = await ShopClient.forShop(shop.shopDomain);
  const [current, previous] = await Promise.all([
    periodStats(api, from, today, tz),
    periodStats(api, prevFrom, from, tz),
  ]);
  const label = daily
    ? `yesterday (${from})`
    : `last 7 days (${from} to ${addDays(today, -1)})`;
  const name = shop.name ?? shop.shopDomain;

  if (target.windowOpen) {
    await sendText(
      target.dest,
      formatSummaryMessage(
        name,
        `Sales ${label}`,
        current,
        previous,
        shop.currencyCode,
      ),
      shop.id,
    );
  } else if (config.whatsapp.templates.summary) {
    await sendTemplate(
      target.dest,
      config.whatsapp.templates.summary,
      config.whatsapp.templates.language,
      [
        name,
        label,
        formatMoney(current.revenue, shop.currencyCode),
        String(current.orders),
      ],
      shop.id,
    );
  } else {
    console.info(
      `[summary] skipped for ${shop.shopDomain}: chat window closed and no summary template configured`,
    );
  }
}

export async function runCheckoutDigestJob(shopId: string) {
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    include: { settings: true },
  });
  if (!hasFeature(shop.plan as PlanId, "checkoutRecovery") || !shop.settings)
    return;
  const target = await updatesDestination(
    shop.id,
    shop.settings.updatesDestination,
  );
  if (!target) return;
  const tz = shop.ianaTimezone ?? "Asia/Kolkata";
  const yesterday = addDays(localNow(tz).date, -1);
  const api = await ShopClient.forShop(shop.shopDomain);
  const checkouts = await fetchAbandonedCheckouts(api, yesterday, 25);
  if (!checkouts.length) return;
  const total = checkouts.reduce((sum, c) => sum + c.amount, 0);
  const value = formatMoney(total, checkouts[0].currency);
  const text =
    `${checkouts.length} abandoned checkout${checkouts.length > 1 ? "s" : ""} since yesterday, worth ${value}.\n` +
    `Reply "Storemate, draft follow-ups" and I'll write messages you can send from your own WhatsApp.`;
  if (target.windowOpen) await sendText(target.dest, text, shop.id);
  else if (config.whatsapp.templates.checkoutDigest)
    await sendTemplate(
      target.dest,
      config.whatsapp.templates.checkoutDigest,
      config.whatsapp.templates.language,
      [String(checkouts.length), value],
      shop.id,
    );
}

/** Housekeeping: old media, finished jobs, expired codes and actions. */
export async function runCleanup() {
  const week = new Date(Date.now() - 7 * 86_400_000);
  await db.mediaAsset.deleteMany({ where: { createdAt: { lt: week } } });
  await db.job.deleteMany({
    where: { status: { in: ["done", "failed"] }, createdAt: { lt: week } },
  });
  await db.linkCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.pendingAction.updateMany({
    where: { status: "pending", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
  await db.waMessage.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
  });
}
