import type { ToolDef } from "../llm/types";
import type { Feature } from "../../lib/plans";

/**
 * Agent tools (provider-neutral JSON Schema). Order is stable so the tools + system prompt prefix
 * caches across all merchants.
 *
 * Tiers are enforced by the tool router, not by the model:
 *   A read-only            -> runs immediately
 *   B low-impact write     -> runs immediately, audited, undoable
 *   C high-impact write    -> creates a pending action; runs only after approval
 *   D destructive          -> like C, and only the owner can approve
 */
export type Tier = "A" | "B" | "C" | "D";

export interface AgentToolDef extends ToolDef {
  tier: Tier;
  /** Plan feature required to use the tool */
  feature?: Feature;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const money = {
  type: "string",
  description: 'Decimal amount in the shop currency, e.g. "799.00"',
};
const gid = (what: string) => ({
  type: "string",
  description: `Shopify GID of the ${what}, e.g. gid://shopify/Product/123`,
});

export const TOOL_DEFS: AgentToolDef[] = [
  // ------------------------------------------------------------ reads
  {
    name: "search_products",
    tier: "A",
    description:
      "Find products by words, SKU, tag or status. Returns id, title, status, price range, stock and links. " +
      "Use before changing a product the merchant names in words.",
    inputSchema: obj(
      {
        query: {
          type: "string",
          description:
            "Plain words or Shopify search syntax (e.g. tag:saree status:active)",
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      ["query"],
    ),
  },
  {
    name: "get_product",
    tier: "A",
    description:
      "Full details of one product: variants with prices and stock, images, SEO, tags, collections.",
    inputSchema: obj({ product_id: gid("product") }, ["product_id"]),
  },
  {
    name: "get_sales_summary",
    tier: "A",
    description:
      "Orders, revenue, average order value, discounts and top products for a date range in the shop timezone, " +
      "optionally compared with the previous period. Use for any question about sales.",
    inputSchema: obj(
      {
        from_date: { type: "string", description: "YYYY-MM-DD inclusive" },
        to_date: { type: "string", description: "YYYY-MM-DD exclusive" },
        compare_previous: { type: "boolean" },
      },
      ["from_date", "to_date"],
    ),
  },
  {
    name: "list_abandoned_checkouts",
    tier: "A",
    feature: "checkoutRecovery",
    description:
      "Abandoned checkouts since a date: value, items, customer first name and whether a phone number exists. " +
      "Phone numbers are never shown to you.",
    inputSchema: obj(
      {
        since: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      ["since"],
    ),
  },
  {
    name: "get_shipping_setup",
    tier: "A",
    description:
      "Shipping profiles, zones and rates with their price conditions, including ids needed to change them.",
    inputSchema: obj({}),
  },

  // ------------------------------------------------------------ writes
  {
    name: "prepare_product_listing",
    tier: "B",
    description:
      "Create a DRAFT product from the photos the merchant just sent plus their details: improves the photos, writes " +
      "the title, description, tags, SEO and alt text, sets variants, price and stock, and uploads images. The merchant " +
      "then gets Publish / Keep as draft buttons automatically. Ask for the price first if it is missing.",
    inputSchema: obj(
      {
        price: money,
        compare_at_price: money,
        merchant_details: {
          type: "string",
          description:
            "Everything the merchant said about the product, verbatim",
        },
        options: {
          type: "array",
          maxItems: 3,
          description:
            "Variant options, e.g. [{name:'Size', values:['S','M','L']}]",
          items: obj(
            {
              name: { type: "string" },
              values: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 30,
              },
            },
            ["name", "values"],
          ),
        },
        stock_per_variant: { type: "integer", minimum: 0 },
      },
      ["price", "merchant_details"],
    ),
  },
  {
    name: "update_product_details",
    tier: "B",
    description:
      "Change a product's title, description, tags, type, vendor or SEO. Needs approval when the product is live.",
    inputSchema: obj(
      {
        product_id: gid("product"),
        title: { type: "string" },
        description_html: { type: "string" },
        tags_add: { type: "array", items: { type: "string" } },
        tags_remove: { type: "array", items: { type: "string" } },
        product_type: { type: "string" },
        vendor: { type: "string" },
        seo_title: { type: "string", maxLength: 70 },
        seo_description: { type: "string", maxLength: 320 },
      },
      ["product_id"],
    ),
  },
  {
    name: "update_prices",
    tier: "C",
    description:
      "Set the price/compare-at price, or change prices by a percentage, for all variants of up to 50 products. " +
      "The merchant approves a before/after list.",
    inputSchema: obj(
      {
        product_ids: {
          type: "array",
          items: gid("product"),
          minItems: 1,
          maxItems: 50,
        },
        set_price: money,
        set_compare_at_price: money,
        percent_change: { type: "number", minimum: -90, maximum: 300 },
      },
      ["product_ids"],
    ),
  },
  {
    name: "set_stock",
    tier: "B",
    description:
      "Set the available quantity for variants at the store's main location.",
    inputSchema: obj(
      {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: obj(
            {
              variant_id: gid("variant"),
              quantity: { type: "integer", minimum: 0 },
            },
            ["variant_id", "quantity"],
          ),
        },
      },
      ["items"],
    ),
  },
  {
    name: "publish_product",
    tier: "C",
    description:
      "Make a product live on the Online Store, or take it off. The merchant approves.",
    inputSchema: obj(
      {
        product_id: gid("product"),
        action: { type: "string", enum: ["publish", "unpublish"] },
      },
      ["product_id", "action"],
    ),
  },
  {
    name: "archive_or_delete_products",
    tier: "D",
    description:
      "Archive (reversible, preferred) or permanently delete products. Only the owner can approve.",
    inputSchema: obj(
      {
        product_ids: {
          type: "array",
          items: gid("product"),
          minItems: 1,
          maxItems: 20,
        },
        mode: { type: "string", enum: ["archive", "delete"] },
      },
      ["product_ids", "mode"],
    ),
  },
  {
    name: "change_shipping_rate",
    tier: "C",
    description:
      "Add, update or remove a flat shipping rate in an existing zone, including free shipping above an order value " +
      "(add a rate with price 0 and min_order_value). Call get_shipping_setup first for ids. The merchant approves.",
    inputSchema: obj(
      {
        operation: { type: "string", enum: ["add", "update", "remove"] },
        profile_id: gid("delivery profile"),
        location_group_id: gid("location group"),
        zone_id: gid("delivery zone"),
        method_definition_id: gid("method definition (update/remove)"),
        rate_definition_id: gid("rate definition (update)"),
        rate_name: { type: "string" },
        price: money,
        min_order_value: money,
        max_order_value: money,
      },
      ["operation", "profile_id"],
    ),
  },
  {
    name: "create_discount",
    tier: "C",
    description:
      "Create a discount code or automatic discount (percentage, fixed amount or free shipping). The merchant approves.",
    inputSchema: obj(
      {
        kind: { type: "string", enum: ["code", "automatic"] },
        code: { type: "string", pattern: "^[A-Za-z0-9_-]{3,30}$" },
        title: { type: "string" },
        value_type: {
          type: "string",
          enum: ["percentage", "fixed_amount", "free_shipping"],
        },
        value: { type: "number", minimum: 0 },
        min_order_value: money,
        starts_at: {
          type: "string",
          description: "ISO date-time; default now",
        },
        ends_at: { type: "string", description: "ISO date-time" },
        usage_limit: { type: "integer", minimum: 1 },
        once_per_customer: { type: "boolean" },
      },
      ["kind", "title", "value_type"],
    ),
  },
  {
    name: "set_store_banner",
    tier: "C",
    description:
      "Show, change or turn off the announcement banner on the storefront (rendered by the Storemate app embed). " +
      "The merchant approves. If the embed is off, tell them to turn it on from the Storemate app in Shopify admin.",
    inputSchema: obj(
      {
        enabled: { type: "boolean" },
        text: { type: "string", maxLength: 140 },
        link_url: { type: "string" },
        style: { type: "string", enum: ["neutral", "dark", "light"] },
        ends_at: {
          type: "string",
          description: "ISO date-time when the banner should stop showing",
        },
      },
      ["enabled"],
    ),
  },
  {
    name: "upsert_page",
    tier: "C",
    description:
      "Create or update an Online Store page (About us, Size guide, Shipping info). The merchant approves.",
    inputSchema: obj(
      {
        page_id: gid("page"),
        title: { type: "string" },
        body_html: { type: "string" },
        published: { type: "boolean" },
      },
      ["title", "body_html"],
    ),
  },
  {
    name: "draft_checkout_recovery",
    tier: "A",
    feature: "checkoutRecovery",
    description:
      "Write short, friendly follow-up messages for abandoned checkouts. The merchant gets tap-to-send links to send " +
      "them from their own WhatsApp. Nothing is sent to customers automatically.",
    inputSchema: obj(
      {
        checkout_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
        tone: { type: "string", enum: ["friendly", "formal", "hinglish"] },
        discount_code: { type: "string" },
      },
      ["checkout_ids"],
    ),
  },
  {
    name: "undo_last_change",
    tier: "B",
    description:
      "Reverse the most recent reversible change (or a specific one from the activity log).",
    inputSchema: obj({ audit_event_id: { type: "string" } }),
  },

  // ------------------------------------------------------------ generic GraphQL (validated against the Admin schema)
  {
    name: "shopify_graphql_query",
    tier: "A",
    description:
      "Read-only Shopify Admin GraphQL query for questions no other tool answers. One `query` operation, validated " +
      "against the Admin API schema; keep first: <= 50 and select only needed fields.",
    inputSchema: obj(
      {
        query: { type: "string" },
        variables: { type: "object", additionalProperties: true },
      },
      ["query"],
    ),
  },
  {
    name: "shopify_graphql_mutation",
    tier: "C",
    description:
      "One Shopify Admin GraphQL mutation from the allowed list, when no other tool fits. Validated against the schema; " +
      "always needs approval. Provide a one-sentence summary for the merchant.",
    inputSchema: obj(
      {
        mutation: { type: "string" },
        variables: { type: "object", additionalProperties: true },
        merchant_summary: { type: "string" },
      },
      ["mutation", "merchant_summary"],
    ),
  },

  // ------------------------------------------------------------ guidance and meta
  {
    name: "guided_fallback",
    tier: "A",
    description:
      "For tasks Shopify offers no API for (theme colours/fonts, payments, domains, installing another app, store " +
      "password, notifications, checkout settings, taxes, staff). Returns steps and the Shopify admin link to send.",
    inputSchema: obj(
      {
        topic: {
          type: "string",
          enum: [
            "theme_design",
            "app_install",
            "payments",
            "domains",
            "store_password",
            "notifications",
            "checkout",
            "taxes",
            "staff",
            "other",
          ],
        },
        task: { type: "string" },
      },
      ["topic", "task"],
    ),
  },
  {
    name: "escalate_model",
    tier: "A",
    description:
      "Hand this conversation to a stronger model. At most once, for multi-step planning or after repeated failure.",
    inputSchema: obj({ reason: { type: "string" } }, ["reason"]),
  },
  {
    name: "remember_preference",
    tier: "B",
    description:
      "Save a stable preference (brand voice, default vendor, language, note). Never customer data.",
    inputSchema: obj(
      {
        key: {
          type: "string",
          enum: [
            "brand_voice",
            "default_vendor",
            "language",
            "default_product_type",
            "note",
          ],
        },
        value: { type: "string", maxLength: 500 },
      },
      ["key", "value"],
    ),
  },
];

export const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

/** Tool list sent to the model: identical for every shop so the prompt cache is shared. */
export function modelTools(): ToolDef[] {
  return TOOL_DEFS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
