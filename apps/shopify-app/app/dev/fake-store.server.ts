/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Graphql } from "../agent/shopify/client.server";

/**
 * Development-only in-memory Shopify store. With FAKE_SHOPIFY_STORE=1 (never in production) the agent
 * talks to this instead of a real store, so the WhatsApp -> agent -> tools -> approval flow can be run
 * end to end with a real LLM before a Partner app and dev store exist.
 * It answers only the operations the agent uses, by operation name.
 */
interface Variant {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number;
}
interface Product {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml: string;
  productType: string;
  vendor: string;
  tags: string[];
  variants: Variant[];
}

const state = {
  products: [
    product(
      1,
      "Indigo Block Print Cotton Kurta",
      "ACTIVE",
      "Kurta",
      ["cotton", "kurta"],
      [
        ["S", "799.00", 5],
        ["M", "799.00", 8],
        ["L", "849.00", 2],
      ],
    ),
    product(
      2,
      "Banarasi Silk Saree – Maroon",
      "ACTIVE",
      "Saree",
      ["silk", "saree"],
      [["Default Title", "4499.00", 3]],
    ),
    product(
      3,
      "Chanderi Saree – Mint",
      "ACTIVE",
      "Saree",
      ["saree"],
      [["Default Title", "2999.00", 4]],
    ),
    product(
      4,
      "Handloom Dupatta",
      "DRAFT",
      "Dupatta",
      ["dupatta"],
      [["Default Title", "599.00", 12]],
    ),
  ] as Product[],
  banner: null as string | null,
  nextId: 100,
  log: [] as string[],
};

function product(
  n: number,
  title: string,
  status: string,
  type: string,
  tags: string[],
  variants: [string, string, number][],
): Product {
  return {
    id: `gid://shopify/Product/${n}`,
    title,
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    status,
    descriptionHtml: `<p>${title}</p>`,
    productType: type,
    vendor: "Kavya Ethnic Wear",
    tags,
    variants: variants.map(([t, price, qty], i) => ({
      id: `gid://shopify/ProductVariant/${n}${i}`,
      title: t,
      price,
      compareAtPrice: null,
      inventoryQuantity: qty,
    })),
  };
}

const money = (amount: string | number) => ({
  amount: String(amount),
  currencyCode: "INR",
});
const productNode = (p: Product) => ({
  id: p.id,
  title: p.title,
  handle: p.handle,
  status: p.status,
  totalInventory: p.variants.reduce((s, v) => s + v.inventoryQuantity, 0),
  onlineStoreUrl:
    p.status === "ACTIVE"
      ? `https://kavya-demo.myshopify.com/products/${p.handle}`
      : null,
  priceRangeV2: {
    minVariantPrice: money(
      Math.min(...p.variants.map((v) => Number(v.price))).toFixed(2),
    ),
    maxVariantPrice: money(
      Math.max(...p.variants.map((v) => Number(v.price))).toFixed(2),
    ),
  },
  descriptionHtml: p.descriptionHtml,
  productType: p.productType,
  vendor: p.vendor,
  tags: p.tags,
  seo: { title: null, description: null },
  options: [{ name: "Size", values: p.variants.map((v) => v.title) }],
  variants: {
    nodes: p.variants.map((v) => ({
      ...v,
      sku: null,
      inventoryItem: { id: v.id.replace("ProductVariant", "InventoryItem") },
    })),
  },
  media: { nodes: [] },
  collections: { nodes: [] },
});

const findProduct = (id: string) => state.products.find((p) => p.id === id);
const findVariant = (id: string) =>
  state.products
    .flatMap((p) => p.variants.map((v) => ({ p, v })))
    .find(
      ({ v }) =>
        v.id === id || v.id.replace("ProductVariant", "InventoryItem") === id,
    );

function handle(name: string, vars: Record<string, any>): unknown {
  switch (name) {
    case "ShopContext":
      return {
        shop: {
          name: "Kavya Ethnic Wear",
          currencyCode: "INR",
          ianaTimezone: "Asia/Kolkata",
          myshopifyDomain: "kavya-demo.myshopify.com",
          primaryDomain: { url: "https://kavya-demo.myshopify.com" },
        },
        currentAppInstallation: { id: "gid://shopify/AppInstallation/1" },
        publications: {
          nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }],
        },
      };
    case "SearchProducts": {
      const words = String(vars.query ?? "")
        .toLowerCase()
        .replace(/\w+:\S+/g, "")
        .split(/\s+/)
        .filter(Boolean);
      const matches = state.products.filter((p) =>
        words.every((w) =>
          `${p.title} ${p.tags.join(" ")} ${p.productType}`
            .toLowerCase()
            .includes(w.replace(/s$/, "")),
        ),
      );
      return {
        products: {
          nodes: matches.slice(0, vars.first ?? 10).map(productNode),
        },
      };
    }
    case "GetProduct":
    case "ProductSnapshot": {
      const p = findProduct(vars.id);
      return { product: p ? productNode(p) : null };
    }
    case "ProductVariantPrices":
      return {
        nodes: (vars.ids as string[])
          .map((id) => findProduct(id))
          .map((p) => (p ? productNode(p) : null)),
      };
    case "VariantStock":
      return {
        nodes: (vars.ids as string[]).map((id) => {
          const hit = findVariant(id);
          return hit
            ? {
                id: hit.v.id,
                title: hit.v.title,
                inventoryQuantity: hit.v.inventoryQuantity,
                product: { title: hit.p.title },
                inventoryItem: {
                  id: hit.v.id.replace("ProductVariant", "InventoryItem"),
                },
              }
            : null;
        }),
      };
    case "PrimaryLocation":
      return {
        locations: {
          nodes: [{ id: "gid://shopify/Location/1", name: "Shop" }],
        },
      };
    case "VariantsBulkUpdate": {
      const p = findProduct(vars.productId);
      for (const input of vars.variants ?? []) {
        const v = p?.variants.find((x) => x.id === input.id);
        if (v && input.price) v.price = input.price;
        if (v && "compareAtPrice" in input)
          v.compareAtPrice = input.compareAtPrice;
      }
      return {
        productVariantsBulkUpdate: {
          productVariants: p?.variants ?? [],
          userErrors: [],
        },
      };
    }
    case "ProductUpdate": {
      const p = findProduct(vars.product.id);
      if (p)
        Object.assign(
          p,
          Object.fromEntries(
            Object.entries(vars.product).filter(
              ([k]) => k !== "id" && k !== "seo",
            ),
          ),
        );
      return {
        productUpdate: {
          product: p ? { id: p.id, status: p.status } : null,
          userErrors: [],
        },
      };
    }
    case "PublishablePublish":
    case "PublishableUnpublish":
      return {
        [name === "PublishablePublish"
          ? "publishablePublish"
          : "publishableUnpublish"]: { userErrors: [] },
      };
    case "InventorySet":
      for (const q of vars.input.quantities) {
        const hit = findVariant(q.inventoryItemId);
        if (hit) hit.v.inventoryQuantity = q.quantity;
      }
      return {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: {
            id: "gid://shopify/InventoryAdjustmentGroup/1",
          },
          userErrors: [],
        },
      };
    case "OrdersInRange": {
      const nodes = Array.from({ length: 23 }, (_, i) => ({
        id: `gid://shopify/Order/${i}`,
        createdAt: new Date(Date.now() - i * 6 * 3600_000).toISOString(),
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        totalPriceSet: {
          shopMoney: money(i % 3 === 0 ? 4499 : 799 + (i % 4) * 50),
        },
        totalDiscountsSet: {
          shopMoney: { amount: i % 5 === 0 ? "100.00" : "0.00" },
        },
        lineItems: {
          nodes: [
            {
              title:
                i % 3 === 0
                  ? "Banarasi Silk Saree – Maroon"
                  : "Indigo Block Print Cotton Kurta",
              quantity: 1,
            },
          ],
        },
      }));
      return {
        orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
      };
    }
    case "AbandonedCheckoutsWithCustomer":
    case "AbandonedCheckouts":
      return {
        abandonedCheckouts: {
          nodes: [
            {
              id: "gid://shopify/AbandonedCheckout/1",
              createdAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
              abandonedCheckoutUrl:
                "https://kavya-demo.myshopify.com/checkouts/abc",
              totalPriceSet: { shopMoney: money("4499.00") },
              lineItems: {
                nodes: [{ title: "Banarasi Silk Saree – Maroon", quantity: 1 }],
              },
              customer: {
                firstName: "Priya",
                defaultPhoneNumber: { phoneNumber: "+919812300001" },
              },
            },
            {
              id: "gid://shopify/AbandonedCheckout/2",
              createdAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
              abandonedCheckoutUrl:
                "https://kavya-demo.myshopify.com/checkouts/def",
              totalPriceSet: { shopMoney: money("1598.00") },
              lineItems: {
                nodes: [
                  { title: "Indigo Block Print Cotton Kurta", quantity: 2 },
                ],
              },
              customer: { firstName: "Ananya", defaultPhoneNumber: null },
            },
          ],
        },
      };
    case "DeliveryProfiles":
      return {
        deliveryProfiles: {
          nodes: [
            {
              id: "gid://shopify/DeliveryProfile/1",
              name: "General profile",
              default: true,
              profileLocationGroups: [
                {
                  locationGroup: {
                    id: "gid://shopify/DeliveryLocationGroup/1",
                  },
                  locationGroupZones: {
                    nodes: [
                      {
                        zone: {
                          id: "gid://shopify/DeliveryZone/1",
                          name: "India",
                          countries: [
                            {
                              name: "India",
                              code: { countryCode: "IN", restOfWorld: false },
                            },
                          ],
                        },
                        methodDefinitions: {
                          nodes: [
                            {
                              id: "gid://shopify/DeliveryMethodDefinition/1",
                              name: "Standard",
                              active: true,
                              rateProvider: {
                                id: "gid://shopify/DeliveryRateDefinition/1",
                                price: money("79.00"),
                              },
                              methodConditions: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };
    case "AppBannerMetafield":
      return {
        currentAppInstallation: {
          id: "gid://shopify/AppInstallation/1",
          metafield: state.banner ? { value: state.banner } : null,
        },
      };
    case "MetafieldsSet":
      state.banner = vars.metafields[0].value;
      return {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/1" }],
          userErrors: [],
        },
      };
    case "StagedUploadsCreate":
      return {
        stagedUploadsCreate: {
          stagedTargets: vars.input.map((f: { filename: string }) => ({
            url: "mock://upload",
            resourceUrl: `https://cdn.example.com/${f.filename}`,
            parameters: [],
          })),
          userErrors: [],
        },
      };
    case "ProductCreate": {
      const id = state.nextId++;
      const p = product(
        id,
        vars.product.title,
        vars.product.status ?? "DRAFT",
        vars.product.productType ?? "",
        vars.product.tags ?? [],
        [["Default Title", "0.00", 0]],
      );
      state.products.push(p);
      return {
        productCreate: {
          product: {
            id: p.id,
            handle: p.handle,
            title: p.title,
            variants: {
              nodes: [
                {
                  id: p.variants[0].id,
                  inventoryItem: {
                    id: p.variants[0].id.replace(
                      "ProductVariant",
                      "InventoryItem",
                    ),
                  },
                },
              ],
            },
          },
          userErrors: [],
        },
      };
    }
    case "VariantsBulkCreate": {
      const p = findProduct(vars.productId);
      if (p)
        p.variants = vars.variants.map(
          (
            v: { optionValues: { name: string }[]; price: string },
            i: number,
          ) => ({
            id: `${p.id.replace("Product", "ProductVariant")}${i}`,
            title: v.optionValues.map((o) => o.name).join(" / "),
            price: v.price,
            compareAtPrice: null,
            inventoryQuantity: 0,
          }),
        );
      return {
        productVariantsBulkCreate: {
          productVariants: p?.variants ?? [],
          userErrors: [],
        },
      };
    }
    case "DeliveryProfileUpdate":
      return {
        deliveryProfileUpdate: { profile: { id: vars.id }, userErrors: [] },
      };
    case "DiscountCodeBasicCreate":
    case "DiscountAutomaticBasicCreate":
    case "DiscountCodeFreeShippingCreate":
    case "DiscountAutomaticFreeShippingCreate": {
      const key = name.charAt(0).toLowerCase() + name.slice(1);
      return {
        [key]: {
          codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
          automaticDiscountNode: {
            id: "gid://shopify/DiscountAutomaticNode/1",
          },
          userErrors: [],
        },
      };
    }
    case "PageCreate":
      return {
        pageCreate: {
          page: { id: "gid://shopify/Page/1", handle: "page" },
          userErrors: [],
        },
      };
    default:
      throw new Error(`Fake store does not support ${name}`);
  }
}

export function fakeStoreGraphql(): Graphql {
  return async (query, options) => {
    const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "anonymous";
    state.log.push(name);
    let body: unknown;
    try {
      body = {
        data: handle(name, (options?.variables ?? {}) as Record<string, any>),
        extensions: {
          cost: {
            throttleStatus: { currentlyAvailable: 1000, restoreRate: 100 },
          },
        },
      };
    } catch (error) {
      body = { errors: [{ message: (error as Error).message }] };
    }
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export const fakeStoreState = state;
