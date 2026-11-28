import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { hasFeature, type PlanId } from "../../lib/plans";
import * as Q from "../shopify/operations";
import { validateDocument, validateOperation } from "../shopify/schema";
import {
  adminUrl,
  approvalCode,
  formatMoney,
  numericId,
  roundPrice,
  truncateLines,
} from "../util";
import { salesSummary } from "../summaries.server";
import {
  fetchAbandonedCheckouts,
  draftRecoveryMessages,
} from "../checkouts.server";
import { prepareProductListing } from "../listing.server";
import { guidedSteps } from "./guided";
import { TOOL_BY_NAME } from "./definitions";
import type { Tier } from "./definitions";

/** Minimal Shopify client the tools need; ShopClient implements it and tests can fake it. */
export interface ShopApi {
  shopDomain: string;
  query<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>,
    estimatedCost?: number,
  ): Promise<T>;
  mutate<T = Record<string, unknown>>(
    mutation: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

export interface Op {
  query: string;
  variables?: Record<string, unknown>;
}

/** A change a write tool wants to make, before the tier decides whether it runs now or waits for approval. */
export interface ChangePlan {
  tool: string;
  tier: Tier;
  summary: string;
  diffText: string;
  ops: Op[];
  undoOps?: Op[];
  /** Shown to the merchant after the change is applied */
  doneMessage?: string;
}

export interface ToolContext {
  shop: {
    id: string;
    shopDomain: string;
    name: string | null;
    currencyCode: string | null;
    ianaTimezone: string | null;
    onlineStorePublicationId: string | null;
    memory: unknown;
  };
  plan: PlanId;
  approvalMode: string;
  api: ShopApi;
  conversationKey: string;
  actor: {
    waId?: string | null;
    name?: string | null;
    role: "owner" | "staff" | "member";
  };
  /** Pending actions created during this turn; the worker sends their approval prompts after the reply */
  proposed: {
    id: string;
    summary: string;
    diffText: string;
    approvalCode: string;
    minRole: string;
    tool: string;
  }[];
  /** Set by escalate_model */
  escalate?: string;
  /** Images to send before the reply (product previews) */
  previews?: { mediaId: string; caption: string }[];
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const ok = (value: unknown): ToolOutcome => ({
  content: typeof value === "string" ? value : JSON.stringify(value),
});
const err = (message: string): ToolOutcome => ({
  content: message,
  isError: true,
});

/** Runs a tool call: checks plan features, validates input shape lightly, dispatches. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const def = TOOL_BY_NAME.get(name);
  if (!def) return err(`Unknown tool ${name}`);
  if (def.feature && !hasFeature(ctx.plan, def.feature)) {
    return ok({
      status: "plan_required",
      message:
        "This is part of the Group plan. Tell the merchant briefly and say they can upgrade from the Storemate app in Shopify admin (Plan page).",
    });
  }
  if ("__invalid_json" in input)
    return err("Tool input was not valid JSON. Try again.");
  try {
    return await dispatch(ctx, name, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed: ${message.slice(0, 600)}`);
  }
}

async function dispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const s = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  const currency = ctx.shop.currencyCode;

  switch (name) {
    case "search_products": {
      const data = await ctx.api.query<{ products: { nodes: ProductNode[] } }>(
        Q.SEARCH_PRODUCTS,
        {
          first: Math.min(Number(input.limit ?? 10), 20),
          query: s("query"),
        },
      );
      return ok(
        data.products.nodes.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          stock: p.totalInventory,
          price:
            p.priceRangeV2.minVariantPrice.amount ===
            p.priceRangeV2.maxVariantPrice.amount
              ? formatMoney(p.priceRangeV2.minVariantPrice.amount, currency)
              : `${formatMoney(p.priceRangeV2.minVariantPrice.amount, currency)}–${formatMoney(p.priceRangeV2.maxVariantPrice.amount, currency)}`,
          url: p.onlineStoreUrl,
          admin: adminUrl(ctx.shop.shopDomain, `products/${numericId(p.id)}`),
        })),
      );
    }

    case "get_product": {
      const data = await ctx.api.query<{
        product: Record<string, unknown> | null;
      }>(Q.GET_PRODUCT, { id: s("product_id") });
      if (!data.product) return err("Product not found");
      return ok(data.product);
    }

    case "get_sales_summary":
      return ok(
        await salesSummary(ctx.api, {
          from: s("from_date")!,
          to: s("to_date")!,
          timeZone: ctx.shop.ianaTimezone ?? "Asia/Kolkata",
          currency,
          comparePrevious: Boolean(input.compare_previous),
        }),
      );

    case "list_abandoned_checkouts": {
      const list = await fetchAbandonedCheckouts(
        ctx.api,
        s("since")!,
        Number(input.limit ?? 10),
      );
      return ok(
        list.map((c) => ({
          id: c.id,
          created: c.createdAt,
          value: formatMoney(c.amount, c.currency),
          items: c.items,
          first_name: c.firstName,
          has_phone: Boolean(c.phone),
        })),
      );
    }

    case "draft_checkout_recovery":
      return ok(
        await draftRecoveryMessages(
          ctx,
          input.checkout_ids as string[],
          (s("tone") as "friendly") ?? "friendly",
          s("discount_code"),
        ),
      );

    case "get_shipping_setup": {
      const data = await ctx.api.query<{
        deliveryProfiles: { nodes: unknown[] };
      }>(Q.DELIVERY_PROFILES, {}, 300);
      return ok(data.deliveryProfiles.nodes);
    }

    case "prepare_product_listing":
      return ok(await prepareProductListing(ctx, input));

    case "update_product_details":
      return applyOrPropose(ctx, await planProductDetails(ctx, input));

    case "update_prices":
      return applyOrPropose(ctx, await planPrices(ctx, input));

    case "set_stock":
      return applyOrPropose(ctx, await planStock(ctx, input));

    case "publish_product":
      return applyOrPropose(
        ctx,
        await planPublish(
          ctx,
          s("product_id")!,
          s("action") === "unpublish" ? "unpublish" : "publish",
        ),
      );

    case "archive_or_delete_products":
      return applyOrPropose(
        ctx,
        await planArchiveDelete(
          ctx,
          input.product_ids as string[],
          s("mode") === "delete" ? "delete" : "archive",
        ),
      );

    case "change_shipping_rate":
      return applyOrPropose(ctx, planShipping(ctx, input));

    case "create_discount":
      return applyOrPropose(ctx, planDiscount(ctx, input));

    case "set_store_banner":
      return applyOrPropose(ctx, await planBanner(ctx, input));

    case "upsert_page":
      return applyOrPropose(ctx, await planPage(ctx, input));

    case "undo_last_change": {
      const { undoAuditEvent } = await import("../../lib/actions.server");
      const event = s("audit_event_id")
        ? await db.auditEvent.findFirst({
            where: { id: s("audit_event_id"), shopId: ctx.shop.id },
          })
        : await db.auditEvent.findFirst({
            where: {
              shopId: ctx.shop.id,
              status: "done",
              NOT: { undoOps: { equals: Prisma.DbNull } },
            },
            orderBy: { createdAt: "desc" },
          });
      if (!event) return ok("There is no recent change that can be undone.");
      const graphql = graphqlFromApi(ctx.api);
      return ok(
        await undoAuditEvent({
          graphql,
          shopId: ctx.shop.id,
          eventId: event.id,
        }),
      );
    }

    case "shopify_graphql_query": {
      const doc = validateDocument(s("query") ?? "");
      if (!doc.ok)
        return err(`Invalid query: ${doc.errors.slice(0, 5).join("; ")}`);
      if (doc.operation !== "query")
        return err("Only read-only queries are allowed here.");
      const data = await ctx.api.query(
        s("query")!,
        (input.variables as Record<string, unknown>) ?? {},
        200,
      );
      const text = JSON.stringify(data);
      return ok(
        text.length > 12000
          ? `${text.slice(0, 12000)}…(truncated; ask for fewer fields or items)`
          : text,
      );
    }

    case "shopify_graphql_mutation": {
      const mutation = s("mutation") ?? "";
      const variables = (input.variables as Record<string, unknown>) ?? {};
      const doc = validateDocument(mutation);
      if (!doc.ok)
        return err(`Invalid mutation: ${doc.errors.slice(0, 5).join("; ")}`);
      if (doc.operation !== "mutation") return err("Send a mutation.");
      const blocked = doc.rootFields.filter(
        (f) => !Q.GENERIC_MUTATION_ALLOWLIST.has(f),
      );
      if (blocked.length)
        return err(
          `Not allowed: ${blocked.join(", ")}. Use a dedicated tool or guided_fallback.`,
        );
      const varErrors = validateOperation(mutation, variables);
      if (varErrors.length)
        return err(`Invalid variables: ${varErrors.slice(0, 5).join("; ")}`);
      return applyOrPropose(ctx, {
        tool: name,
        tier: "C",
        summary: s("merchant_summary") ?? "Store change",
        diffText: s("merchant_summary") ?? "",
        ops: [{ query: mutation, variables }],
      });
    }

    case "guided_fallback":
      return ok(
        guidedSteps(
          ctx.shop.shopDomain,
          s("topic") ?? "other",
          s("task") ?? "",
        ),
      );

    case "escalate_model":
      ctx.escalate = s("reason") ?? "requested";
      return ok(
        "Escalating to a stronger model for the rest of this conversation.",
      );

    case "remember_preference": {
      const memory = {
        ...((ctx.shop.memory as Record<string, string>) ?? {}),
        [s("key")!]: s("value")!,
      };
      await db.shop.update({ where: { id: ctx.shop.id }, data: { memory } });
      ctx.shop.memory = memory;
      return ok("Saved.");
    }
  }
  return err(`Tool ${name} is not implemented`);
}

// ------------------------------------------------------------------ apply or propose

/** Tier B runs now (audited, undoable). Tier C/D become pending actions that need approval. */
export async function applyOrPropose(
  ctx: ToolContext,
  plan: ChangePlan | ToolOutcome,
): Promise<ToolOutcome> {
  if (!("ops" in plan)) return plan;
  const tier = plan.tier;
  const strictB =
    ctx.approvalMode === "strict" &&
    tier === "B" &&
    plan.tool !== "prepare_product_listing";

  if (tier === "B" && !strictB) {
    for (const op of plan.ops) await ctx.api.mutate(op.query, op.variables);
    await db.auditEvent.create({
      data: {
        shopId: ctx.shop.id,
        actor: "agent",
        waId: ctx.actor.waId ?? null,
        tool: plan.tool,
        summary: plan.summary,
        undoOps: (plan.undoOps ?? undefined) as
          Prisma.InputJsonValue | undefined,
      },
    });
    return ok({
      status: "done",
      summary: plan.summary,
      message: plan.doneMessage,
    });
  }

  const pending = await createPendingAction(
    ctx,
    plan,
    tier === "D" ? "owner" : "member",
  );
  return ok({
    status: "needs_approval",
    summary: plan.summary,
    approval_code: pending.approvalCode,
    note: "Approve/Cancel options are sent automatically after your reply. Write one short line saying what will change. Do not say it is done.",
  });
}

export async function createPendingAction(
  ctx: ToolContext,
  plan: ChangePlan,
  minRole: "member" | "owner",
) {
  const code = approvalCode();
  const row = await db.pendingAction.create({
    data: {
      shopId: ctx.shop.id,
      tool: plan.tool,
      summary: plan.summary,
      diffText: plan.diffText,
      ops: plan.ops as unknown as Prisma.InputJsonValue,
      undoOps: (plan.undoOps ?? undefined) as Prisma.InputJsonValue | undefined,
      approvalCode: code,
      conversationKey: ctx.conversationKey,
      minRole,
      requestedByWaId: ctx.actor.waId ?? null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  ctx.proposed.push({
    id: row.id,
    summary: plan.summary,
    diffText: plan.diffText,
    approvalCode: code,
    minRole,
    tool: plan.tool,
  });
  return { id: row.id, approvalCode: code };
}

export function graphqlFromApi(api: ShopApi) {
  return async (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => {
    const data = await api.query(query, options?.variables);
    return new Response(JSON.stringify({ data }), {
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ------------------------------------------------------------------ planners (pure given reads; tested against the schema)

interface ProductNode {
  id: string;
  title: string;
  status: string;
  totalInventory: number;
  onlineStoreUrl: string | null;
  priceRangeV2: {
    minVariantPrice: { amount: string };
    maxVariantPrice: { amount: string };
  };
}

export async function planProductDetails(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ChangePlan | ToolOutcome> {
  const id = String(input.product_id);
  const { product } = await ctx.api.query<{
    product: {
      id: string;
      title: string;
      status: string;
      descriptionHtml: string;
      productType: string;
      vendor: string;
      tags: string[];
      seo: { title: string | null; description: string | null };
    } | null;
  }>(Q.PRODUCT_SNAPSHOT, { id });
  if (!product) return err("Product not found");

  const next: Record<string, unknown> = { id };
  const before: Record<string, unknown> = { id };
  const lines: string[] = [];
  const set = (key: string, value: unknown, prev: unknown, label: string) => {
    if (value === undefined || value === prev) return;
    next[key] = value;
    before[key] = prev;
    lines.push(`${label}: ${short(prev)} → ${short(value)}`);
  };
  set("title", input.title, product.title, "Title");
  set(
    "descriptionHtml",
    input.description_html,
    product.descriptionHtml,
    "Description",
  );
  set("productType", input.product_type, product.productType, "Type");
  set("vendor", input.vendor, product.vendor, "Vendor");
  const add = (input.tags_add as string[] | undefined) ?? [];
  const remove = new Set(
    ((input.tags_remove as string[] | undefined) ?? []).map((t) =>
      t.toLowerCase(),
    ),
  );
  if (add.length || remove.size) {
    const tags = [
      ...new Set([
        ...product.tags.filter((t) => !remove.has(t.toLowerCase())),
        ...add,
      ]),
    ];
    next.tags = tags;
    before.tags = product.tags;
    lines.push(
      `Tags: ${product.tags.join(", ") || "none"} → ${tags.join(", ") || "none"}`,
    );
  }
  if (input.seo_title !== undefined || input.seo_description !== undefined) {
    next.seo = {
      title: input.seo_title ?? product.seo.title,
      description: input.seo_description ?? product.seo.description,
    };
    before.seo = {
      title: product.seo.title,
      description: product.seo.description,
    };
    lines.push("SEO title/description updated");
  }
  if (lines.length === 0) return ok("Nothing to change.");
  return {
    tool: "update_product_details",
    tier: product.status === "ACTIVE" ? "C" : "B",
    summary: `Update “${product.title}”`,
    diffText: lines.join("\n"),
    ops: [{ query: Q.PRODUCT_UPDATE, variables: { product: next } }],
    undoOps: [{ query: Q.PRODUCT_UPDATE, variables: { product: before } }],
  };
}

export async function planPrices(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ChangePlan | ToolOutcome> {
  const ids = input.product_ids as string[];
  if (
    input.set_price === undefined &&
    input.percent_change === undefined &&
    input.set_compare_at_price === undefined
  ) {
    return err("Give set_price, set_compare_at_price or percent_change.");
  }
  const { nodes } = await ctx.api.query<{
    nodes: ({
      id: string;
      title: string;
      variants: {
        nodes: {
          id: string;
          title: string;
          price: string;
          compareAtPrice: string | null;
        }[];
      };
    } | null)[];
  }>(Q.PRODUCT_VARIANT_PRICES, { ids }, 200);

  const ops: Op[] = [];
  const undoOps: Op[] = [];
  const lines: string[] = [];
  const currency = ctx.shop.currencyCode;
  for (const product of nodes) {
    if (!product?.variants) continue;
    const whole = product.variants.nodes.every(
      (v) => Number(v.price) % 1 === 0,
    );
    const next = product.variants.nodes.map((v) => {
      const price =
        input.set_price !== undefined
          ? roundPrice(Number(input.set_price), false)
          : input.percent_change !== undefined
            ? roundPrice(
                Number(v.price) * (1 + Number(input.percent_change) / 100),
                whole,
              )
            : v.price;
      const compareAtPrice =
        input.set_compare_at_price !== undefined
          ? roundPrice(Number(input.set_compare_at_price), false)
          : undefined;
      const label =
        product.variants.nodes.length > 1
          ? `${product.title} – ${v.title}`
          : product.title;
      if (price !== v.price)
        lines.push(
          `${label}: ${formatMoney(v.price, currency)} → ${formatMoney(price, currency)}`,
        );
      if (compareAtPrice !== undefined)
        lines.push(
          `${label}: compare-at ${v.compareAtPrice ? formatMoney(v.compareAtPrice, currency) : "none"} → ${formatMoney(compareAtPrice, currency)}`,
        );
      return {
        id: v.id,
        price,
        ...(compareAtPrice !== undefined ? { compareAtPrice } : {}),
      };
    });
    ops.push({
      query: Q.VARIANTS_BULK_UPDATE,
      variables: { productId: product.id, variants: next },
    });
    undoOps.push({
      query: Q.VARIANTS_BULK_UPDATE,
      variables: {
        productId: product.id,
        variants: product.variants.nodes.map((v) => ({
          id: v.id,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
        })),
      },
    });
  }
  if (!ops.length) return err("No matching products found.");
  const count = ops.length;
  return {
    tool: "update_prices",
    tier: "C",
    summary: `Change prices for ${count} product${count === 1 ? "" : "s"}`,
    diffText: truncateLines(lines),
    ops,
    undoOps,
  };
}

export async function planStock(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ChangePlan | ToolOutcome> {
  const items = input.items as { variant_id: string; quantity: number }[];
  const [{ nodes }, { locations }] = await Promise.all([
    ctx.api.query<{
      nodes: ({
        id: string;
        title: string;
        inventoryQuantity: number;
        product: { title: string };
        inventoryItem: { id: string };
      } | null)[];
    }>(Q.VARIANT_STOCK, { ids: items.map((i) => i.variant_id) }),
    ctx.api.query<{ locations: { nodes: { id: string; name: string }[] } }>(
      Q.PRIMARY_LOCATION,
    ),
  ]);
  const location = locations.nodes[0];
  if (!location) return err("No active location found.");
  const quantities: Record<string, unknown>[] = [];
  const undo: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const item of items) {
    const variant = nodes.find((n) => n?.id === item.variant_id);
    if (!variant) continue;
    quantities.push({
      inventoryItemId: variant.inventoryItem.id,
      locationId: location.id,
      quantity: item.quantity,
      changeFromQuantity: null,
    });
    undo.push({
      inventoryItemId: variant.inventoryItem.id,
      locationId: location.id,
      quantity: variant.inventoryQuantity,
      changeFromQuantity: null,
    });
    lines.push(
      `${variant.product.title} – ${variant.title}: ${variant.inventoryQuantity} → ${item.quantity}`,
    );
  }
  if (!quantities.length) return err("Variants not found.");
  const input_ = (q: Record<string, unknown>[]) => ({
    input: { name: "available", reason: "correction", quantities: q },
  });
  return {
    tool: "set_stock",
    tier: "B",
    summary: `Update stock for ${quantities.length} variant${quantities.length === 1 ? "" : "s"}`,
    diffText: truncateLines(lines),
    ops: [{ query: Q.INVENTORY_SET, variables: input_(quantities) }],
    undoOps: [{ query: Q.INVENTORY_SET, variables: input_(undo) }],
  };
}

export async function onlineStorePublicationId(
  ctx: ToolContext,
): Promise<string | null> {
  if (ctx.shop.onlineStorePublicationId)
    return ctx.shop.onlineStorePublicationId;
  const data = await ctx.api.query<{
    publications: { nodes: { id: string; name: string }[] };
  }>(Q.SHOP_CONTEXT);
  const pub = data.publications.nodes.find(
    (p) => p.name.toLowerCase() === "online store",
  );
  if (pub) {
    ctx.shop.onlineStorePublicationId = pub.id;
    await db.shop
      .update({
        where: { id: ctx.shop.id },
        data: { onlineStorePublicationId: pub.id },
      })
      .catch(() => undefined);
  }
  return pub?.id ?? null;
}

export async function planPublish(
  ctx: ToolContext,
  productId: string,
  action: "publish" | "unpublish",
): Promise<ChangePlan | ToolOutcome> {
  const { product } = await ctx.api.query<{
    product: { id: string; title: string; status: string } | null;
  }>(Q.PRODUCT_SNAPSHOT, {
    id: productId,
  });
  if (!product) return err("Product not found");
  const publicationId = await onlineStorePublicationId(ctx);
  if (!publicationId)
    return err("The Online Store sales channel was not found.");
  const pub = {
    query: Q.PUBLISHABLE_PUBLISH,
    variables: { id: productId, input: [{ publicationId }] },
  };
  const unpub = {
    query: Q.PUBLISHABLE_UNPUBLISH,
    variables: { id: productId, input: [{ publicationId }] },
  };
  if (action === "publish") {
    return {
      tool: "publish_product",
      tier: "C",
      summary: `Publish “${product.title}”`,
      diffText: `Status: ${product.status.toLowerCase()} → active\nVisible on: Online Store`,
      ops: [
        {
          query: Q.PRODUCT_UPDATE,
          variables: { product: { id: productId, status: "ACTIVE" } },
        },
        pub,
      ],
      undoOps: [
        unpub,
        {
          query: Q.PRODUCT_UPDATE,
          variables: { product: { id: productId, status: product.status } },
        },
      ],
    };
  }
  return {
    tool: "publish_product",
    tier: "C",
    summary: `Take “${product.title}” off the Online Store`,
    diffText: "Visible on Online Store: yes → no",
    ops: [unpub],
    undoOps: [pub],
  };
}

export async function planArchiveDelete(
  ctx: ToolContext,
  ids: string[],
  mode: "archive" | "delete",
): Promise<ChangePlan | ToolOutcome> {
  const { nodes } = await ctx.api.query<{
    nodes: ({ id: string; title: string; status: string } | null)[];
  }>(Q.PRODUCT_VARIANT_PRICES, { ids });
  const found = nodes.filter(
    (n): n is { id: string; title: string; status: string } => Boolean(n?.id),
  );
  if (!found.length) return err("Products not found.");
  const titles = found.map((p) => `• ${p.title}`);
  if (mode === "archive") {
    return {
      tool: "archive_or_delete_products",
      tier: "D",
      summary: `Archive ${found.length} product${found.length === 1 ? "" : "s"}`,
      diffText: truncateLines(titles),
      ops: found.map((p) => ({
        query: Q.PRODUCT_UPDATE,
        variables: { product: { id: p.id, status: "ARCHIVED" } },
      })),
      undoOps: found.map((p) => ({
        query: Q.PRODUCT_UPDATE,
        variables: { product: { id: p.id, status: p.status } },
      })),
    };
  }
  return {
    tool: "archive_or_delete_products",
    tier: "D",
    summary: `Permanently delete ${found.length} product${found.length === 1 ? "" : "s"} (cannot be undone)`,
    diffText: truncateLines(titles),
    ops: found.map((p) => ({
      query: Q.PRODUCT_DELETE,
      variables: { id: p.id },
    })),
  };
}

export function planShipping(
  ctx: ToolContext,
  input: Record<string, unknown>,
): ChangePlan | ToolOutcome {
  const currencyCode = ctx.shop.currencyCode ?? "INR";
  const op = String(input.operation);
  const profileId = String(input.profile_id);
  const money = (amount: unknown) => ({ amount: String(amount), currencyCode });
  const conditions = () => {
    const list: Record<string, unknown>[] = [];
    if (input.min_order_value !== undefined)
      list.push({
        criteria: money(input.min_order_value),
        operator: "GREATER_THAN_OR_EQUAL_TO",
      });
    if (input.max_order_value !== undefined)
      list.push({
        criteria: money(input.max_order_value),
        operator: "LESS_THAN_OR_EQUAL_TO",
      });
    return list;
  };
  const describe = () =>
    `${input.rate_name ?? "Rate"}: ${formatMoney(String(input.price ?? 0), currencyCode)}` +
    (input.min_order_value !== undefined
      ? ` for orders ≥ ${formatMoney(String(input.min_order_value), currencyCode)}`
      : "") +
    (input.max_order_value !== undefined
      ? ` for orders ≤ ${formatMoney(String(input.max_order_value), currencyCode)}`
      : "");

  if (op === "remove") {
    if (!input.method_definition_id)
      return err("method_definition_id is required to remove a rate.");
    return {
      tool: "change_shipping_rate",
      tier: "C",
      summary:
        `Remove shipping rate ${input.rate_name ? `“${input.rate_name}”` : ""}`.trim(),
      diffText: `Remove: ${input.rate_name ?? input.method_definition_id}`,
      ops: [
        {
          query: Q.DELIVERY_PROFILE_UPDATE,
          variables: {
            id: profileId,
            profile: {
              methodDefinitionsToDelete: [input.method_definition_id],
            },
          },
        },
      ],
    };
  }
  if (!input.location_group_id || !input.zone_id)
    return err(
      "location_group_id and zone_id are required. Call get_shipping_setup.",
    );
  if (input.price === undefined) return err("price is required.");

  if (op === "add") {
    return {
      tool: "change_shipping_rate",
      tier: "C",
      summary: `Add shipping rate: ${describe()}`,
      diffText: `New rate → ${describe()}`,
      ops: [
        {
          query: Q.DELIVERY_PROFILE_UPDATE,
          variables: {
            id: profileId,
            profile: {
              locationGroupsToUpdate: [
                {
                  id: input.location_group_id,
                  zonesToUpdate: [
                    {
                      id: input.zone_id,
                      methodDefinitionsToCreate: [
                        {
                          name: String(input.rate_name ?? "Shipping"),
                          active: true,
                          rateDefinition: { price: money(input.price) },
                          priceConditionsToCreate: conditions(),
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      // Undo for an added rate needs its new id; the merchant can remove it with another request.
    };
  }
  if (!input.method_definition_id || !input.rate_definition_id)
    return err(
      "method_definition_id and rate_definition_id are required to update.",
    );
  return {
    tool: "change_shipping_rate",
    tier: "C",
    summary: `Update shipping rate: ${describe()}`,
    diffText: `Updated rate → ${describe()}`,
    ops: [
      {
        query: Q.DELIVERY_PROFILE_UPDATE,
        variables: {
          id: profileId,
          profile: {
            locationGroupsToUpdate: [
              {
                id: input.location_group_id,
                zonesToUpdate: [
                  {
                    id: input.zone_id,
                    methodDefinitionsToUpdate: [
                      {
                        id: input.method_definition_id,
                        ...(input.rate_name
                          ? { name: String(input.rate_name) }
                          : {}),
                        rateDefinition: {
                          id: input.rate_definition_id,
                          price: money(input.price),
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };
}

export function planDiscount(
  ctx: ToolContext,
  input: Record<string, unknown>,
): ChangePlan | ToolOutcome {
  const kind = String(input.kind);
  const valueType = String(input.value_type);
  const title = String(input.title);
  const code = input.code ? String(input.code).toUpperCase() : undefined;
  if (kind === "code" && !code)
    return err("A code is required for a discount code.");
  if (valueType !== "free_shipping" && input.value === undefined)
    return err("value is required.");
  const currency = ctx.shop.currencyCode;
  const common: Record<string, unknown> = {
    title,
    startsAt: input.starts_at ?? new Date().toISOString(),
    ...(input.ends_at ? { endsAt: input.ends_at } : {}),
    context: { all: "ALL" },
    ...(input.min_order_value !== undefined
      ? {
          minimumRequirement: {
            subtotal: {
              greaterThanOrEqualToSubtotal: String(input.min_order_value),
            },
          },
        }
      : {}),
  };
  const codeExtras =
    kind === "code"
      ? {
          code,
          ...(input.usage_limit ? { usageLimit: input.usage_limit } : {}),
          appliesOncePerCustomer: Boolean(input.once_per_customer),
        }
      : {};
  const valueText =
    valueType === "percentage"
      ? `${input.value}% off`
      : valueType === "fixed_amount"
        ? `${formatMoney(Number(input.value), currency)} off`
        : "Free shipping";
  const lines = [
    `${kind === "code" ? `Code ${code}` : "Automatic discount"}: ${valueText}`,
    input.min_order_value !== undefined
      ? `Minimum order: ${formatMoney(Number(input.min_order_value), currency)}`
      : "",
    input.ends_at
      ? `Ends: ${String(input.ends_at).slice(0, 16).replace("T", " ")}`
      : "No end date",
  ].filter(Boolean);

  let query: string;
  let variables: Record<string, unknown>;
  if (valueType === "free_shipping") {
    const body = { ...common, ...codeExtras, destination: { all: true } };
    query =
      kind === "code"
        ? Q.DISCOUNT_CODE_FREE_SHIPPING_CREATE
        : Q.DISCOUNT_AUTOMATIC_FREE_SHIPPING_CREATE;
    variables =
      kind === "code"
        ? { freeShippingCodeDiscount: body }
        : { freeShippingAutomaticDiscount: body };
  } else {
    const value =
      valueType === "percentage"
        ? { percentage: Number(input.value) / 100 }
        : {
            discountAmount: {
              amount: String(input.value),
              appliesOnEachItem: false,
            },
          };
    const body = {
      ...common,
      ...codeExtras,
      customerGets: { value, items: { all: true } },
    };
    query =
      kind === "code"
        ? Q.DISCOUNT_CODE_BASIC_CREATE
        : Q.DISCOUNT_AUTOMATIC_BASIC_CREATE;
    variables =
      kind === "code"
        ? { basicCodeDiscount: body }
        : { automaticBasicDiscount: body };
  }
  return {
    tool: "create_discount",
    tier: "C",
    summary: `Create discount: ${title}`,
    diffText: lines.join("\n"),
    ops: [{ query, variables }],
  };
}

export async function planBanner(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ChangePlan | ToolOutcome> {
  const { currentAppInstallation } = await ctx.api.query<{
    currentAppInstallation: { id: string; metafield: { value: string } | null };
  }>(Q.APP_METAFIELD);
  const previous =
    currentAppInstallation.metafield?.value ??
    JSON.stringify({ enabled: false });
  const enabled = Boolean(input.enabled);
  if (enabled && !input.text) return err("text is required to show a banner.");
  const config = enabled
    ? {
        enabled: true,
        text: String(input.text),
        link_url: input.link_url ?? "",
        style: input.style ?? "neutral",
        ends_at: input.ends_at ?? "",
      }
    : { ...safeJson(previous), enabled: false };
  const set = (value: string) => ({
    query: Q.METAFIELDS_SET,
    variables: {
      metafields: [
        {
          ownerId: currentAppInstallation.id,
          namespace: "banner",
          key: "config",
          type: "json",
          value,
        },
      ],
    },
  });
  return {
    tool: "set_store_banner",
    tier: "C",
    summary: enabled
      ? `Show store banner: “${config.text}”`
      : "Turn off the store banner",
    diffText: enabled
      ? [
          `Text: “${config.text}”`,
          input.link_url ? `Link: ${input.link_url}` : "",
          input.ends_at
            ? `Until: ${String(input.ends_at).slice(0, 16).replace("T", " ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "Banner: on → off",
    ops: [set(JSON.stringify(config))],
    undoOps: [set(previous)],
    doneMessage:
      "If the banner doesn't show, turn on the Storemate banner in the theme editor (step 2 in the app).",
  };
}

export async function planPage(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ChangePlan | ToolOutcome> {
  const title = String(input.title);
  const body = String(input.body_html);
  const published = input.published !== false;
  if (input.page_id) {
    const { page } = await ctx.api.query<{
      page: {
        id: string;
        title: string;
        body: string;
        isPublished: boolean;
      } | null;
    }>(Q.PAGE_GET, { id: input.page_id });
    if (!page) return err("Page not found");
    return {
      tool: "upsert_page",
      tier: "C",
      summary: `Update page “${page.title}”`,
      diffText: `Title: ${page.title} → ${title}\nContent updated${page.isPublished !== published ? `\nPublished: ${page.isPublished} → ${published}` : ""}`,
      ops: [
        {
          query: Q.PAGE_UPDATE,
          variables: {
            id: page.id,
            page: { title, body, isPublished: published },
          },
        },
      ],
      undoOps: [
        {
          query: Q.PAGE_UPDATE,
          variables: {
            id: page.id,
            page: {
              title: page.title,
              body: page.body,
              isPublished: page.isPublished,
            },
          },
        },
      ],
    };
  }
  return {
    tool: "upsert_page",
    tier: "C",
    summary: `Create page “${title}”`,
    diffText: `New page: ${title}${published ? " (published)" : " (hidden)"}\n${short(body.replace(/<[^>]+>/g, " "), 200)}`,
    ops: [
      {
        query: Q.PAGE_CREATE,
        variables: { page: { title, body, isPublished: published } },
      },
    ],
  };
}

function short(value: unknown, max = 60): string {
  const text =
    value === null || value === undefined || value === ""
      ? "none"
      : String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
