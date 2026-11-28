/**
 * Tool definitions for the WhatsApp store agent (v0.1).
 *
 * Ordering matters for prompt caching: keep this array stable and deterministic.
 * Tools render before the system prompt, so any change here invalidates the shared cache prefix.
 *
 * Tiers (enforced by the tool router, NOT by the model):
 *   A  read-only                     -> runs immediately
 *   B  low-impact write (reversible) -> runs immediately, audited, undoable
 *   C  high-impact write             -> returns needs_approval; frozen ops run on merchant button tap
 *   D  destructive                   -> approval from an owner, plus a second confirmation button
 *   E  computer use                  -> approval, feature flag, per-month quota (see docs/06)
 *
 * Every input is validated server-side (zod) before execution, whatever the model sends.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type Tier = "A" | "B" | "C" | "D" | "E";
export type Rung = "typed_api" | "generic_graphql" | "guided" | "computer_use" | "meta";

export interface AgentTool {
  tier: Tier;
  rung: Rung;
  /** Optional scope that must be granted before the tool is exposed to the model. */
  requiresScopes?: string[];
  definition: Anthropic.Tool;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Anthropic.Tool["input_schema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const money = { type: "string", description: "Decimal amount in shop currency, e.g. \"799.00\"" };
const gid = (what: string) => ({ type: "string", description: `Shopify GID of the ${what}` });

export const TOOLS: AgentTool[] = [
  // ---------------------------------------------------------------- rung a: typed API tools (reads)
  {
    tier: "A", rung: "typed_api",
    definition: {
      name: "search_products",
      description:
        "Find products by title, SKU, tag, status or collection. Returns id, title, status, price range, " +
        "inventory total and admin/storefront URLs. Use before updating a product the merchant names in words.",
      input_schema: obj({
        query: { type: "string", description: "Shopify product search syntax or plain words" },
        status: { type: "string", enum: ["ACTIVE", "DRAFT", "ARCHIVED", "ANY"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      }, ["query"]),
    },
  },
  {
    tier: "A", rung: "typed_api",
    definition: {
      name: "get_product",
      description: "Full details of one product: variants, prices, inventory, media, SEO, tags, collections.",
      input_schema: obj({ product_id: gid("product") }, ["product_id"]),
    },
  },
  {
    tier: "A", rung: "typed_api",
    definition: {
      name: "get_sales_summary",
      description:
        "Orders, revenue, average order value, top products, repeat-customer share and discount usage for a date range " +
        "in the shop timezone. Use for any 'how are sales' question.",
      input_schema: obj({
        from_date: { type: "string", description: "YYYY-MM-DD inclusive" },
        to_date: { type: "string", description: "YYYY-MM-DD exclusive" },
        compare_previous: { type: "boolean", description: "Also compute the previous equal-length period" },
      }, ["from_date", "to_date"]),
    },
  },
  {
    tier: "A", rung: "typed_api", requiresScopes: ["read_orders"],
    definition: {
      name: "list_abandoned_checkouts",
      description:
        "Abandoned checkouts since a date, with value, items, first name and whether a phone exists. " +
        "Customer phone numbers are never returned to you; drafts are linked server-side.",
      input_schema: obj({
        since: { type: "string", description: "YYYY-MM-DD" },
        min_value: money,
        limit: { type: "integer", minimum: 1, maximum: 50 },
      }, ["since"]),
    },
  },
  {
    tier: "A", rung: "typed_api", requiresScopes: ["read_shipping"],
    definition: {
      name: "get_shipping_setup",
      description: "Delivery profiles, zones (countries/states) and rates with their price/weight conditions.",
      input_schema: obj({}),
    },
  },
  {
    tier: "A", rung: "typed_api",
    definition: {
      name: "get_store_setup_status",
      description:
        "Checks store readiness: Online Store publication, app banner block/embed installed in the live theme, " +
        "granted optional scopes, WhatsApp template status, current plan and remaining monthly agent budget.",
      input_schema: obj({}),
    },
  },

  // ---------------------------------------------------------------- rung a: typed API tools (writes)
  {
    tier: "B", rung: "typed_api",
    definition: {
      name: "prepare_product_listing",
      description:
        "Turn a media batch from WhatsApp plus merchant details into a DRAFT product: analyses photos, removes " +
        "backgrounds on packshots, enhances images, writes SEO title/description/tags/alt text, creates the product " +
        "with variants and price, uploads images, and returns a preview for the merchant. Does not publish.",
      input_schema: obj({
        media_batch_id: { type: "string" },
        price: money,
        compare_at_price: money,
        merchant_details: { type: "string", description: "Everything the merchant said about the product, verbatim" },
        options: {
          type: "array",
          description: "Variant options, e.g. [{name:'Size', values:['S','M','L']}]",
          items: obj({
            name: { type: "string" },
            values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 },
          }, ["name", "values"]),
          maxItems: 3,
        },
        inventory_per_variant: { type: "integer", minimum: 0 },
        image_style: { type: "string", enum: ["auto", "white_background", "keep_original"] },
        premium_copy: { type: "boolean", description: "Use the higher-quality copywriting model (costs more)" },
      }, ["media_batch_id", "price", "merchant_details"]),
    },
  },
  {
    tier: "B", rung: "typed_api",
    definition: {
      name: "update_product_details",
      description:
        "Change title, description, tags, product type, vendor or SEO fields. Tier C automatically if the product is ACTIVE.",
      input_schema: obj({
        product_id: gid("product"),
        title: { type: "string" },
        description_html: { type: "string" },
        tags_add: { type: "array", items: { type: "string" } },
        tags_remove: { type: "array", items: { type: "string" } },
        product_type: { type: "string" },
        vendor: { type: "string" },
        seo_title: { type: "string", maxLength: 70 },
        seo_description: { type: "string", maxLength: 320 },
      }, ["product_id"]),
    },
  },
  {
    tier: "C", rung: "typed_api",
    definition: {
      name: "update_prices",
      description:
        "Set price and/or compare-at price for variants of one or more products, or apply a percentage change. " +
        "Returns needs_approval with a before/after table.",
      input_schema: obj({
        product_ids: { type: "array", items: gid("product"), minItems: 1, maxItems: 250 },
        set_price: money,
        set_compare_at_price: money,
        percent_change: { type: "number", minimum: -90, maximum: 300 },
        variant_filter: { type: "string", description: "Optional option value filter, e.g. 'Size:XL'" },
      }, ["product_ids"]),
    },
  },
  {
    tier: "B", rung: "typed_api",
    definition: {
      name: "set_inventory",
      description: "Set available quantity for variants at the default (or named) location.",
      input_schema: obj({
        items: {
          type: "array", minItems: 1, maxItems: 100,
          items: obj({ variant_id: gid("variant"), quantity: { type: "integer", minimum: 0 } }, ["variant_id", "quantity"]),
        },
        location_name: { type: "string" },
      }, ["items"]),
    },
  },
  {
    tier: "C", rung: "typed_api",
    definition: {
      name: "publish_product",
      description: "Set product ACTIVE and publish to the Online Store (or unpublish). Returns needs_approval.",
      input_schema: obj({
        product_id: gid("product"),
        action: { type: "string", enum: ["publish", "unpublish"] },
      }, ["product_id", "action"]),
    },
  },
  {
    tier: "D", rung: "typed_api",
    definition: {
      name: "archive_or_delete_products",
      description: "Archive (reversible) or permanently delete products. Prefer archive. Returns needs_approval.",
      input_schema: obj({
        product_ids: { type: "array", items: gid("product"), minItems: 1, maxItems: 50 },
        mode: { type: "string", enum: ["archive", "delete"] },
      }, ["product_ids", "mode"]),
    },
  },
  {
    tier: "B", rung: "typed_api",
    definition: {
      name: "manage_collection",
      description: "Create a manual collection or add/remove products to/from an existing one.",
      input_schema: obj({
        collection_id: gid("collection"),
        create_title: { type: "string" },
        add_product_ids: { type: "array", items: gid("product") },
        remove_product_ids: { type: "array", items: gid("product") },
      }),
    },
  },
  {
    tier: "C", rung: "typed_api", requiresScopes: ["write_shipping"],
    definition: {
      name: "change_shipping_rate",
      description:
        "Add, update or remove a shipping rate in a zone, including free-shipping thresholds (e.g. free above 999). " +
        "Call get_shipping_setup first. Returns needs_approval with a plain-language diff.",
      input_schema: obj({
        operation: { type: "string", enum: ["add", "update", "remove"] },
        profile_id: gid("delivery profile"),
        zone_name: { type: "string", description: "Existing zone name, or new zone name when adding" },
        countries: { type: "array", items: { type: "string", description: "ISO country code" } },
        rate_name: { type: "string" },
        price: money,
        min_order_subtotal: money,
        max_order_subtotal: money,
        method_definition_id: gid("method definition (for update/remove)"),
      }, ["operation", "profile_id", "zone_name", "rate_name"]),
    },
  },
  {
    tier: "C", rung: "typed_api", requiresScopes: ["write_discounts"],
    definition: {
      name: "create_discount",
      description: "Create a discount code or automatic discount. Returns needs_approval.",
      input_schema: obj({
        kind: { type: "string", enum: ["code", "automatic"] },
        code: { type: "string", pattern: "^[A-Z0-9_-]{3,30}$" },
        title: { type: "string" },
        value_type: { type: "string", enum: ["percentage", "fixed_amount", "free_shipping"] },
        value: { type: "number", minimum: 0 },
        min_subtotal: money,
        starts_at: { type: "string", description: "ISO datetime; default now" },
        ends_at: { type: "string" },
        usage_limit: { type: "integer", minimum: 1 },
        once_per_customer: { type: "boolean" },
      }, ["kind", "title", "value_type"]),
    },
  },
  {
    tier: "C", rung: "typed_api",
    definition: {
      name: "set_store_banner",
      description:
        "Set or turn off the storefront announcement banner rendered by this app's theme block. If the block is " +
        "not installed in the live theme, returns a one-tap theme editor link for the merchant instead.",
      input_schema: obj({
        enabled: { type: "boolean" },
        text: { type: "string", maxLength: 140 },
        link_url: { type: "string" },
        style: { type: "string", enum: ["neutral", "dark", "light"] },
        starts_at: { type: "string" },
        ends_at: { type: "string" },
      }, ["enabled"]),
    },
  },
  {
    tier: "C", rung: "typed_api", requiresScopes: ["write_online_store_pages"],
    definition: {
      name: "upsert_page",
      description: "Create or update an Online Store page (About, Size guide, Shipping info). Returns needs_approval if published.",
      input_schema: obj({
        page_id: gid("page"),
        title: { type: "string" },
        body_html: { type: "string" },
        published: { type: "boolean" },
      }, ["title"]),
    },
  },
  {
    tier: "A", rung: "typed_api", requiresScopes: ["read_orders"],
    definition: {
      name: "draft_checkout_recovery",
      description:
        "Draft short, personal WhatsApp recovery messages for abandoned checkouts. Returns drafts with tap-to-send " +
        "links that the merchant sends from their own WhatsApp. Nothing is sent automatically.",
      input_schema: obj({
        checkout_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        tone: { type: "string", enum: ["friendly", "formal", "hinglish"] },
        discount_code: { type: "string", description: "Existing code to mention, optional" },
      }, ["checkout_ids"]),
    },
  },
  {
    tier: "B", rung: "typed_api",
    definition: {
      name: "undo_change",
      description: "Revert a previous reversible change from the audit log (default: the most recent one).",
      input_schema: obj({ audit_event_id: { type: "string" } }),
    },
  },

  // ---------------------------------------------------------------- rung b: schema-validated generic GraphQL
  {
    tier: "A", rung: "generic_graphql",
    definition: {
      name: "shopify_graphql_query",
      description:
        "Run a read-only GraphQL Admin API query when no typed tool fits. Must be a single `query` operation; it is " +
        "validated against the Admin schema and rejected if estimated cost > 500. Select only needed fields; first: <= 50.",
      input_schema: obj({
        query: { type: "string" },
        variables: { type: "object", additionalProperties: true },
      }, ["query"]),
    },
  },
  {
    tier: "C", rung: "generic_graphql",
    definition: {
      name: "shopify_graphql_mutation",
      description:
        "Run one GraphQL Admin API mutation from the allowlist when no typed tool fits. Validated against the schema; " +
        "always returns needs_approval with a plain-language summary you provide.",
      input_schema: obj({
        mutation: { type: "string" },
        variables: { type: "object", additionalProperties: true },
        merchant_summary: { type: "string", description: "One sentence describing the change for the approval message" },
      }, ["mutation", "merchant_summary"]),
    },
  },

  // ---------------------------------------------------------------- rung c: guided fallback
  {
    tier: "A", rung: "guided",
    definition: {
      name: "guided_fallback",
      description:
        "For tasks with no API (theme colours/fonts, payments, domains, installing another app, store password, " +
        "notification templates, checkout settings). Returns curated steps and a Shopify admin deep link to send.",
      input_schema: obj({
        task: { type: "string", description: "What the merchant wants, in one sentence" },
        topic: {
          type: "string",
          enum: ["theme_design", "app_install", "payments", "domains", "store_password", "notifications",
                 "checkout_settings", "taxes", "markets", "staff", "other"],
        },
      }, ["task", "topic"]),
    },
  },

  // ---------------------------------------------------------------- rung d: computer use (exposed only when flag on)
  {
    tier: "E", rung: "computer_use",
    definition: {
      name: "request_computer_use",
      description:
        "Last resort. Ask to perform an admin UI task that has no API and no adequate guided path. Only for tasks on " +
        "the allowlist; never payments, payouts, domains, staff, billing, app installs or deletion. Requires approval.",
      input_schema: obj({
        task: { type: "string" },
        why_api_cannot: { type: "string", description: "Which rungs were checked and why they cannot do it" },
        allowlisted_task_id: { type: "string" },
      }, ["task", "why_api_cannot", "allowlisted_task_id"]),
    },
  },

  // ---------------------------------------------------------------- meta tools
  {
    tier: "A", rung: "meta",
    definition: {
      name: "escalate_model",
      description: "Hand this episode to a stronger model. Use at most once, for multi-step planning or repeated failure.",
      input_schema: obj({ reason: { type: "string" } }, ["reason"]),
    },
  },
  {
    tier: "B", rung: "meta",
    definition: {
      name: "remember_preference",
      description: "Store a stable merchant preference (brand voice, default vendor, language). Never customer data.",
      input_schema: obj({
        key: { type: "string", enum: ["brand_voice", "default_vendor", "language", "default_product_type", "note"] },
        value: { type: "string", maxLength: 500 },
      }, ["key", "value"]),
    },
  },
];

/**
 * Tools exposed to the model. The list deliberately does NOT vary by granted scopes: an identical
 * tools+system prefix across all merchants maximises prompt-cache hits. Missing scopes are handled at
 * execution time (the router returns `scope_required` and the agent sends the merchant a one-tap grant link).
 * Only the computer-use flag changes the list, which gives exactly two cache variants.
 */
export function toolsForShop(computerUseEnabled: boolean): Anthropic.Tool[] {
  return TOOLS.filter((t) => t.rung !== "computer_use" || computerUseEnabled).map((t) => t.definition);
}

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.definition.name, t]));
