import * as Q from "./shopify/operations";
import { addDays, formatMoney, localMidnightIso } from "./util";
import type { ShopApi } from "./tools/handlers.server";

interface OrderNode {
  createdAt: string;
  cancelledAt: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: { nodes: { title: string; quantity: number }[] };
}

export interface PeriodStats {
  from: string;
  to: string;
  orders: number;
  revenue: number;
  discounts: number;
  averageOrderValue: number;
  topProducts: { title: string; quantity: number }[];
  truncated: boolean;
}

const MAX_PAGES = 8; // 2,000 orders; enough for a weekly summary of a small store

export async function periodStats(
  api: ShopApi,
  from: string,
  to: string,
  timeZone: string,
): Promise<PeriodStats> {
  const query = `created_at:>='${localMidnightIso(from, timeZone)}' created_at:<'${localMidnightIso(to, timeZone)}'`;
  const orders: OrderNode[] = [];
  let after: string | null = null;
  let pages = 0;
  let truncated = false;
  do {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: OrderNode[];
      };
    } = await api.query(Q.ORDERS_IN_RANGE, { query, after }, 600);
    orders.push(...data.orders.nodes);
    after = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;
    pages++;
    if (after && pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
  } while (after);

  const valid = orders.filter((o) => !o.cancelledAt);
  const revenue = valid.reduce(
    (sum, o) => sum + Number(o.totalPriceSet.shopMoney.amount),
    0,
  );
  const discounts = valid.reduce(
    (sum, o) => sum + Number(o.totalDiscountsSet.shopMoney.amount),
    0,
  );
  const byProduct = new Map<string, number>();
  for (const order of valid)
    for (const item of order.lineItems.nodes)
      byProduct.set(
        item.title,
        (byProduct.get(item.title) ?? 0) + item.quantity,
      );
  const topProducts = [...byProduct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([title, quantity]) => ({ title, quantity }));

  return {
    from,
    to,
    orders: valid.length,
    revenue: round2(revenue),
    discounts: round2(discounts),
    averageOrderValue: valid.length ? round2(revenue / valid.length) : 0,
    topProducts,
    truncated,
  };
}

export async function salesSummary(
  api: ShopApi,
  opts: {
    from: string;
    to: string;
    timeZone: string;
    currency: string | null;
    comparePrevious?: boolean;
  },
) {
  const current = await periodStats(api, opts.from, opts.to, opts.timeZone);
  let previous: PeriodStats | null = null;
  if (opts.comparePrevious) {
    const days = Math.round(
      (Date.parse(opts.to) - Date.parse(opts.from)) / 86_400_000,
    );
    previous = await periodStats(
      api,
      addDays(opts.from, -days),
      opts.from,
      opts.timeZone,
    );
  }
  return {
    currency: opts.currency,
    current: {
      ...current,
      revenueText: formatMoney(current.revenue, opts.currency),
      aovText: formatMoney(current.averageOrderValue, opts.currency),
    },
    previous: previous && {
      ...previous,
      revenueText: formatMoney(previous.revenue, opts.currency),
    },
  };
}

function pct(now: number, before: number): string {
  if (!before) return now ? "new" : "same";
  const change = Math.round(((now - before) / before) * 100);
  return change === 0 ? "same" : `${change > 0 ? "+" : ""}${change}%`;
}

/** Plain WhatsApp text for scheduled daily/weekly summaries (no LLM needed). */
export function formatSummaryMessage(
  shopName: string,
  label: string,
  current: PeriodStats,
  previous: PeriodStats | null,
  currency: string | null,
): string {
  const lines = [
    `*${shopName}: ${label}*`,
    `Revenue: ${formatMoney(current.revenue, currency)}${previous ? ` (${pct(current.revenue, previous.revenue)})` : ""}`,
    `Orders: ${current.orders}${previous ? ` (${pct(current.orders, previous.orders)})` : ""}`,
    `Average order: ${formatMoney(current.averageOrderValue, currency)}`,
  ];
  if (current.discounts > 0)
    lines.push(`Discounts given: ${formatMoney(current.discounts, currency)}`);
  if (current.topProducts.length) {
    lines.push("", "Top products:");
    for (const p of current.topProducts.slice(0, 3))
      lines.push(`- ${p.title} (${p.quantity})`);
  }
  if (current.orders === 0)
    lines.push(
      "",
      "No orders in this period. Want ideas to bring shoppers back? Just ask.",
    );
  if (current.truncated)
    lines.push("", "(Large volume: figures cover the first 2,000 orders.)");
  return lines.join("\n");
}

const round2 = (n: number) => Math.round(n * 100) / 100;
