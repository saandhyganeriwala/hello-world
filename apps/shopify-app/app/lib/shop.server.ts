import db from "../db.server";

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

/**
 * Makes sure our own Shop row exists for an authenticated admin session.
 * Called from the /app layout loader, so every page can rely on it.
 */
export async function ensureShop(shopDomain: string, graphql: AdminGraphql) {
  let shop = await db.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });

  if (!shop || shop.uninstalledAt) {
    shop = await db.shop.upsert({
      where: { shopDomain },
      create: { shopDomain, settings: { create: {} } },
      update: { uninstalledAt: null, installedAt: new Date() },
      include: { settings: true },
    });
  }
  if (!shop.settings) {
    await db.shopSettings.create({ data: { shopId: shop.id } });
    shop = await db.shop.findUniqueOrThrow({
      where: { id: shop.id },
      include: { settings: true },
    });
  }
  if (!shop.name) {
    try {
      const res = await graphql(`
        #graphql
        query ShopName {
          shop {
            name
          }
        }
      `);
      const json = (await res.json()) as {
        data?: { shop?: { name?: string } };
      };
      const name = json.data?.shop?.name;
      if (name)
        shop = await db.shop.update({
          where: { id: shop.id },
          data: { name },
          include: { settings: true },
        });
    } catch {
      // Non-fatal: the name is cosmetic.
    }
  }
  return shop as typeof shop & { settings: NonNullable<typeof shop.settings> };
}

export async function getShopByDomain(shopDomain: string) {
  return db.shop.findUnique({ where: { shopDomain } });
}

export function activeMerchantUsers(shopId: string) {
  return db.merchantUser.findMany({
    where: { shopId, revokedAt: null },
    orderBy: { linkedAt: "asc" },
  });
}

export function startOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function monthlyStats(shopId: string, monthlyBudgetUsd: number) {
  const since = startOfMonth();
  const [messages, changes, products, usage] = await Promise.all([
    db.waMessage.count({
      where: { shopId, direction: "in", createdAt: { gte: since } },
    }),
    db.auditEvent.count({
      where: { shopId, status: "done", createdAt: { gte: since } },
    }),
    db.auditEvent.count({
      where: {
        shopId,
        status: "done",
        tool: "prepare_product_listing",
        createdAt: { gte: since },
      },
    }),
    db.llmUsage.aggregate({
      where: { shopId, createdAt: { gte: since } },
      _sum: { costUsd: true },
    }),
  ]);
  const spent = Number(usage._sum.costUsd ?? 0);
  const budgetUsedPercent =
    monthlyBudgetUsd > 0
      ? Math.min(100, Math.round((spent / monthlyBudgetUsd) * 100))
      : 0;
  return { messages, changes, products, budgetUsedPercent };
}
