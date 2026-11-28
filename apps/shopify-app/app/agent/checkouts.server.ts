import * as Q from "./shopify/operations";
import { complete, modelFor, costUsd, textOf } from "./llm";
import { recordUsage } from "./usage.server";
import { formatMoney } from "./util";
import type { ShopApi, ToolContext } from "./tools/handlers.server";

export interface Checkout {
  id: string;
  createdAt: string;
  url: string;
  amount: number;
  currency: string;
  items: string[];
  firstName: string | null;
  phone: string | null;
}

interface CheckoutNode {
  id: string;
  createdAt: string;
  abandonedCheckoutUrl: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { nodes: { title: string; quantity: number }[] };
  customer?: {
    firstName: string | null;
    defaultPhoneNumber: { phoneNumber: string } | null;
  } | null;
}

/**
 * Abandoned checkouts since a date. Customer name and phone need the read_customers scope and
 * protected customer data approval; without them we fall back to checkouts without customer fields.
 */
export async function fetchAbandonedCheckouts(
  api: ShopApi,
  since: string,
  limit = 10,
): Promise<Checkout[]> {
  const variables = {
    first: Math.min(limit, 25),
    query: `created_at:>='${since}'`,
  };
  let nodes: CheckoutNode[];
  try {
    const data = await api.query<{
      abandonedCheckouts: { nodes: CheckoutNode[] };
    }>(Q.ABANDONED_CHECKOUTS_WITH_CUSTOMER, variables, 200);
    nodes = data.abandonedCheckouts.nodes;
  } catch {
    const data = await api.query<{
      abandonedCheckouts: { nodes: CheckoutNode[] };
    }>(Q.ABANDONED_CHECKOUTS, variables, 200);
    nodes = data.abandonedCheckouts.nodes;
  }
  return nodes.map((n) => ({
    id: n.id,
    createdAt: n.createdAt,
    url: n.abandonedCheckoutUrl,
    amount: Number(n.totalPriceSet.shopMoney.amount),
    currency: n.totalPriceSet.shopMoney.currencyCode,
    items: n.lineItems.nodes.map(
      (i) => `${i.title}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`,
    ),
    firstName: n.customer?.firstName ?? null,
    phone: n.customer?.defaultPhoneNumber?.phoneNumber ?? null,
  }));
}

/**
 * Drafts recovery messages with the summary model. Phone numbers never reach the model: the
 * tap-to-send wa.me links are built here, after drafting.
 */
export async function draftRecoveryMessages(
  ctx: Pick<ToolContext, "api" | "shop">,
  checkoutIds: string[],
  tone: "friendly" | "formal" | "hinglish",
  discountCode?: string,
) {
  const since = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const all = await fetchAbandonedCheckouts(ctx.api, since, 25);
  const selected = all.filter((c) => checkoutIds.includes(c.id));
  if (!selected.length)
    return {
      drafts: [],
      note: "Those checkouts were not found in the last 30 days.",
    };

  const ref = modelFor("summary");
  const result = await complete(ref, {
    system:
      "You write short WhatsApp follow-ups from a shop owner to a customer who left items in their cart. " +
      "Warm, personal, under 60 words, no pressure, no false urgency, one clear link placeholder {link}. " +
      "Return JSON only.",
    tools: [],
    maxTokens: 2000,
    effort: "low",
    jsonSchema: {
      name: "drafts",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["drafts"],
        properties: {
          drafts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "message"],
              properties: {
                id: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
    messages: [
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: JSON.stringify({
              store: ctx.shop.name,
              tone,
              discount_code: discountCode ?? null,
              checkouts: selected.map((c) => ({
                id: c.id,
                first_name: c.firstName,
                items: c.items,
                value: formatMoney(c.amount, c.currency),
              })),
            }),
          },
        ],
      },
    ],
  });
  await recordUsage(
    ctx.shop.id,
    null,
    "checkout_drafts",
    result,
    costUsd(result.provider, result.model, result.usage),
  );

  let drafts: { id: string; message: string }[] = [];
  try {
    drafts = JSON.parse(textOf(result.parts)).drafts ?? [];
  } catch {
    return { drafts: [], note: "Could not draft messages right now." };
  }
  return {
    drafts: drafts.map((d) => {
      const checkout = selected.find((c) => c.id === d.id);
      const message = d.message.replace("{link}", checkout?.url ?? "");
      const digits = checkout?.phone?.replace(/\D/g, "");
      return {
        customer: checkout?.firstName ?? "Customer",
        value: checkout ? formatMoney(checkout.amount, checkout.currency) : "",
        message,
        send_link: digits
          ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
          : null,
      };
    }),
    note: "Show each draft with its send_link. The merchant sends it from their own WhatsApp. If send_link is null, the customer left no phone number.",
  };
}
