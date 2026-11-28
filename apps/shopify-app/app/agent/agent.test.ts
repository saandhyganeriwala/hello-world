import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));

import * as Q from "./shopify/operations";
import { validateOperation } from "./shopify/schema";
import {
  planArchiveDelete,
  planBanner,
  planDiscount,
  planPage,
  planPrices,
  planProductDetails,
  planPublish,
  planShipping,
  planStock,
  type ChangePlan,
  type ShopApi,
  type ToolContext,
} from "./tools/handlers.server";
import { cartesian } from "./listing.server";
import { TOOL_DEFS } from "./tools/definitions";
import { toAnthropicMessage, fromAnthropicContent } from "./llm/anthropic";
import { toOpenAIMessages } from "./llm/openai";
import { costUsd, parseModelRef, type Message } from "./llm";
import {
  addDays,
  localMidnightIso,
  localNow,
  roundPrice,
  tzOffset,
} from "./util";
import { isAddressedToBot, parseApprovalText } from "../jobs/turn.server";
import {
  hasFeature,
  maxDirectNumbers,
  planFromSubscriptionName,
} from "../lib/plans";

/** Fake Shopify reads keyed by the operation they answer. */
function fakeApi(responses: Record<string, unknown>): ShopApi {
  return {
    shopDomain: "demo.myshopify.com",
    async query(query: string) {
      const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "";
      if (!(name in responses)) throw new Error(`no fake for ${name}`);
      return responses[name] as never;
    },
    async mutate() {
      return {} as never;
    },
  };
}

function ctxWith(api: ShopApi): ToolContext {
  return {
    shop: {
      id: "shop1",
      shopDomain: "demo.myshopify.com",
      name: "Demo",
      currencyCode: "INR",
      ianaTimezone: "Asia/Kolkata",
      onlineStorePublicationId: "gid://shopify/Publication/1",
      memory: {},
    },
    plan: "group",
    approvalMode: "standard",
    api,
    conversationKey: "dm:919800000000",
    actor: { waId: "919800000000", name: "Kavya", role: "owner" },
    proposed: [],
  };
}

function expectValid(plan: ChangePlan | { content: string }) {
  expect("ops" in plan).toBe(true);
  const p = plan as ChangePlan;
  for (const op of [...p.ops, ...(p.undoOps ?? [])])
    expect(validateOperation(op.query, op.variables)).toEqual([]);
  return p;
}

const product = {
  id: "gid://shopify/Product/1",
  title: "Cotton Kurta",
  status: "ACTIVE",
  descriptionHtml: "<p>Soft</p>",
  productType: "Kurta",
  vendor: "Demo",
  tags: ["cotton", "summer"],
  seo: { title: null, description: null },
};

describe("change planners produce schema-valid operations", () => {
  it("product details (live product needs approval)", async () => {
    const api = fakeApi({ ProductSnapshot: { product } });
    const plan = expectValid(
      await planProductDetails(ctxWith(api), {
        product_id: product.id,
        title: "Indigo Cotton Kurta",
        tags_add: ["indigo"],
        tags_remove: ["summer"],
        seo_title: "Indigo kurta",
      }),
    );
    expect(plan.tier).toBe("C");
    expect(plan.diffText).toContain(
      "Title: Cotton Kurta → Indigo Cotton Kurta",
    );
    expect(
      (plan.ops[0].variables as { product: { tags: string[] } }).product.tags,
    ).toEqual(["cotton", "indigo"]);
  });

  it("prices by percentage keep whole numbers", async () => {
    const api = fakeApi({
      ProductVariantPrices: {
        nodes: [
          {
            ...product,
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/11",
                  title: "S",
                  price: "799.00",
                  compareAtPrice: null,
                },
              ],
            },
          },
        ],
      },
    });
    const plan = expectValid(
      await planPrices(ctxWith(api), {
        product_ids: [product.id],
        percent_change: 10,
      }),
    );
    expect(
      (plan.ops[0].variables as { variants: { price: string }[] }).variants[0]
        .price,
    ).toBe("879.00");
    expect(plan.diffText).toMatch(/₹799 → ₹879/);
    expect(plan.tier).toBe("C");
  });

  it("stock", async () => {
    const api = fakeApi({
      VariantStock: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/11",
            title: "S",
            inventoryQuantity: 3,
            product: { title: "Kurta" },
            inventoryItem: { id: "gid://shopify/InventoryItem/5" },
          },
        ],
      },
      PrimaryLocation: {
        locations: {
          nodes: [{ id: "gid://shopify/Location/9", name: "Shop" }],
        },
      },
    });
    const plan = expectValid(
      await planStock(ctxWith(api), {
        items: [
          { variant_id: "gid://shopify/ProductVariant/11", quantity: 10 },
        ],
      }),
    );
    expect(plan.diffText).toContain("3 → 10");
  });

  it("publish and unpublish", async () => {
    const api = fakeApi({
      ProductSnapshot: { product: { ...product, status: "DRAFT" } },
    });
    expectValid(await planPublish(ctxWith(api), product.id, "publish"));
    expectValid(await planPublish(ctxWith(api), product.id, "unpublish"));
  });

  it("archive and delete are owner-only (tier D)", async () => {
    const api = fakeApi({
      ProductVariantPrices: {
        nodes: [{ ...product, variants: { nodes: [] } }],
      },
    });
    expect(
      expectValid(
        await planArchiveDelete(ctxWith(api), [product.id], "archive"),
      ).tier,
    ).toBe("D");
    expect(
      expectValid(await planArchiveDelete(ctxWith(api), [product.id], "delete"))
        .tier,
    ).toBe("D");
  });

  it("shipping: add free shipping above a value, update and remove", () => {
    const ctx = ctxWith(fakeApi({}));
    const base = {
      profile_id: "gid://shopify/DeliveryProfile/1",
      location_group_id: "gid://shopify/DeliveryLocationGroup/2",
      zone_id: "gid://shopify/DeliveryZone/3",
    };
    const add = expectValid(
      planShipping(ctx, {
        ...base,
        operation: "add",
        rate_name: "Free shipping",
        price: "0",
        min_order_value: "999",
      }),
    );
    expect(add.summary).toContain("₹999");
    expectValid(
      planShipping(ctx, {
        ...base,
        operation: "update",
        method_definition_id: "gid://shopify/DeliveryMethodDefinition/4",
        rate_definition_id: "gid://shopify/DeliveryRateDefinition/5",
        price: "49",
      }),
    );
    expectValid(
      planShipping(ctx, {
        ...base,
        operation: "remove",
        method_definition_id: "gid://shopify/DeliveryMethodDefinition/4",
      }),
    );
  });

  it.each([
    ["code", "percentage", 20],
    ["code", "fixed_amount", 100],
    ["code", "free_shipping", undefined],
    ["automatic", "percentage", 10],
    ["automatic", "free_shipping", undefined],
  ])("discount %s %s", (kind, valueType, value) => {
    const plan = expectValid(
      planDiscount(ctxWith(fakeApi({})), {
        kind,
        value_type: valueType,
        value,
        title: "Diwali",
        code: "diwali20",
        min_order_value: "999",
        ends_at: "2026-12-01T23:59:00+05:30",
        usage_limit: 100,
      }),
    );
    expect(plan.tier).toBe("C");
  });

  it("banner on and off (with undo to the previous value)", async () => {
    const api = fakeApi({
      AppBannerMetafield: {
        currentAppInstallation: {
          id: "gid://shopify/AppInstallation/1",
          metafield: null,
        },
      },
    });
    const on = expectValid(
      await planBanner(ctxWith(api), {
        enabled: true,
        text: "Diwali sale 20% off",
        ends_at: "2026-12-01T23:59:00+05:30",
      }),
    );
    expect(on.undoOps).toHaveLength(1);
    expectValid(await planBanner(ctxWith(api), { enabled: false }));
  });

  it("pages: create and update", async () => {
    const api = fakeApi({
      PageGet: {
        page: {
          id: "gid://shopify/Page/1",
          title: "About",
          body: "<p>Hi</p>",
          isPublished: true,
        },
      },
    });
    expectValid(
      await planPage(ctxWith(api), {
        title: "Size guide",
        body_html: "<p>S M L</p>",
      }),
    );
    expectValid(
      await planPage(ctxWith(api), {
        page_id: "gid://shopify/Page/1",
        title: "About us",
        body_html: "<p>Hello</p>",
      }),
    );
  });

  it("listing variant inputs are schema-valid", () => {
    const combos = cartesian([
      ["S", "M"].map((name) => ({ optionName: "Size", name })),
      ["Red", "Blue"].map((name) => ({ optionName: "Color", name })),
    ]);
    expect(combos).toHaveLength(4);
    const errors = validateOperation(Q.VARIANTS_BULK_CREATE, {
      productId: "gid://shopify/Product/1",
      variants: combos.map((optionValues) => ({
        optionValues,
        price: "799.00",
        inventoryItem: { tracked: true },
        inventoryQuantities: [
          { availableQuantity: 5, locationId: "gid://shopify/Location/1" },
        ],
      })),
    });
    expect(errors).toEqual([]);
    expect(
      validateOperation(Q.PRODUCT_CREATE, {
        product: {
          title: "Kurta",
          descriptionHtml: "<p>x</p>",
          tags: ["a"],
          seo: { title: "t", description: "d" },
          status: "DRAFT",
          productOptions: [{ name: "Size", values: [{ name: "S" }] }],
        },
        media: [
          {
            originalSource: "https://example.com/a.jpg",
            alt: "a",
            mediaContentType: "IMAGE",
          },
        ],
      }),
    ).toEqual([]);
    expect(
      validateOperation(Q.STAGED_UPLOADS_CREATE, {
        input: [
          {
            resource: "IMAGE",
            filename: "a.jpg",
            mimeType: "image/jpeg",
            httpMethod: "POST",
            fileSize: "1234",
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("tool definitions", () => {
  it("have unique names and object schemas", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFS) expect(t.inputSchema.type).toBe("object");
  });
});

describe("LLM adapters", () => {
  const conversation: Message[] = [
    { role: "user", parts: [{ type: "text", text: "Raise kurta prices 10%" }] },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Checking" },
        {
          type: "tool_call",
          id: "call_1",
          name: "search_products",
          input: { query: "kurta" },
        },
      ],
      native: {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Checking" },
        ],
      },
    },
    {
      role: "user",
      parts: [{ type: "tool_result", toolCallId: "call_1", content: "[]" }],
    },
  ];

  it("Claude: replays native content for the same model, converts for another", () => {
    expect(
      toAnthropicMessage(conversation[1], "claude-haiku-5-5").content,
    ).toEqual(conversation[1].native!.content);
    const converted = toAnthropicMessage(conversation[1], "claude-sonnet-5-5")
      .content as { type: string }[];
    expect(converted.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(toAnthropicMessage(conversation[2], "x").content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "[]",
        is_error: undefined,
      },
    ]);
  });

  it("Claude: keeps text and tool calls, leaves thinking in native", () => {
    const parts = fromAnthropicContent([
      { type: "thinking", thinking: "", signature: "s" } as never,
      { type: "text", text: "Hi", citations: null } as never,
      {
        type: "tool_use",
        id: "t1",
        name: "get_product",
        input: { product_id: "x" },
        caller: { type: "direct" },
      } as never,
    ]);
    expect(parts).toEqual([
      { type: "text", text: "Hi" },
      {
        type: "tool_call",
        id: "t1",
        name: "get_product",
        input: { product_id: "x" },
      },
    ]);
  });

  it("OpenAI: assistant tool calls and tool results map to chat messages", () => {
    const assistant = toOpenAIMessages(conversation[1])[0] as {
      role: string;
      tool_calls: { function: { name: string; arguments: string } }[];
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0].function).toEqual({
      name: "search_products",
      arguments: '{"query":"kurta"}',
    });
    expect(toOpenAIMessages(conversation[2])).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "[]" },
    ]);
    const withImage = toOpenAIMessages({
      role: "user",
      parts: [
        { type: "text", text: "hi" },
        { type: "image", mediaType: "image/jpeg", data: "AAA" },
      ],
    });
    expect(withImage[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      ],
    });
  });

  it("model refs and cost", () => {
    expect(parseModelRef("openai:gpt-5-mini")).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
    });
    expect(() => parseModelRef("gpt-5")).toThrow();
    const cost = costUsd("anthropic", "claude-haiku-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.6);
  });
});

describe("WhatsApp turn rules", () => {
  it("parses typed approvals", () => {
    expect(parseApprovalText("YES 4821")).toEqual({
      decision: "approve",
      code: "4821",
    });
    expect(parseApprovalText("no #4821")).toEqual({
      decision: "reject",
      code: "4821",
    });
    expect(parseApprovalText("haan")).toEqual({
      decision: "approve",
      code: null,
    });
    expect(parseApprovalText("yes please add a banner")).toBeNull();
  });

  it("answers in groups only when addressed", () => {
    expect(
      isAddressedToBot("Storemate, how were sales?", null, "+91 98100 00000"),
    ).toBe(true);
    expect(
      isAddressedToBot("@919810000000 add this", null, "+91 98100 00000"),
    ).toBe(true);
    expect(
      isAddressedToBot("ok sounds good", "919810000000", "+91 98100 00000"),
    ).toBe(true);
    expect(
      isAddressedToBot("lunch at 2?", "919811111111", "+91 98100 00000"),
    ).toBe(false);
  });
});

describe("plans", () => {
  it("maps subscription names and gates features", () => {
    expect(planFromSubscriptionName("Storemate Group")).toBe("group");
    expect(planFromSubscriptionName("Solo")).toBe("solo");
    expect(planFromSubscriptionName(null)).toBe("none");
    expect(hasFeature("solo", "summaries")).toBe(false);
    expect(hasFeature("group", "checkoutRecovery")).toBe(true);
    expect(maxDirectNumbers("solo")).toBe(1);
    expect(maxDirectNumbers("group")).toBe(8);
  });
});

describe("time helpers", () => {
  it("handles India and DST zones", () => {
    expect(tzOffset("Asia/Kolkata")).toBe("+05:30");
    expect(localMidnightIso("2026-11-21", "Asia/Kolkata")).toBe(
      "2026-11-21T00:00:00+05:30",
    );
    expect(localMidnightIso("2026-07-01", "America/New_York")).toBe(
      "2026-07-01T00:00:00-04:00",
    );
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(
      localNow("Asia/Kolkata", new Date("2026-11-28T20:00:00Z")),
    ).toMatchObject({ date: "2026-11-29", hour: 1, weekday: 7 });
    expect(roundPrice(878.9, true)).toBe("879.00");
  });
});
