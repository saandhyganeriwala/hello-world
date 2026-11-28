import sharp from "sharp";
import db from "../db.server";
import { complete, costUsd, modelFor, textOf, type Part } from "./llm";
import * as Q from "./shopify/operations";
import { recordUsage } from "./usage.server";
import { adminUrl, formatMoney, numericId } from "./util";
import {
  createPendingAction,
  planPublish,
  type ToolContext,
} from "./tools/handlers.server";
import { uploadMedia } from "../lib/whatsapp-api.server";

/**
 * Photos + merchant details -> DRAFT product with variants, price, stock and images, then a
 * Publish approval. Image work is lightweight and local (sharp): orientation fix, resize to
 * 2048px for the store and 768px for the vision model. Background removal is a later milestone
 * (separate image service, see docs/02-tech-stack.md).
 */

export const LISTING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "description_html",
    "seo_title",
    "seo_description",
    "tags",
    "product_type",
    "alt_texts",
    "assumptions",
  ],
  properties: {
    title: {
      type: "string",
      description: "Specific product title, max 70 characters",
    },
    description_html: {
      type: "string",
      description:
        "2 short paragraphs and a bullet list; only <p>, <ul>, <li>, <strong>",
    },
    seo_title: { type: "string", description: "Max 60 characters" },
    seo_description: { type: "string", description: "Max 155 characters" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Up to 12 search-friendly tags",
    },
    product_type: { type: "string" },
    alt_texts: {
      type: "array",
      items: { type: "string" },
      description: "One alt text per photo, in order",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Anything you inferred that the merchant did not say",
    },
  },
} as const;

const LISTING_PROMPT = `You write product listings for small online stores.
Write for shoppers and search engines: specific, honest and easy to scan.
Only state facts the merchant gave or that are clearly visible in the photos. Never invent materials, sizes,
certifications, origins or medical claims. Put anything you inferred in "assumptions".
Do not mention prices or discounts in the description. Use the store's language (English unless told otherwise).`;

interface Listing {
  title: string;
  description_html: string;
  seo_title: string;
  seo_description: string;
  tags: string[];
  product_type: string;
  alt_texts: string[];
  assumptions: string[];
}

export async function prepareProductListing(
  ctx: ToolContext,
  input: Record<string, unknown>,
) {
  const assets = await db.mediaAsset.findMany({
    where: {
      shopId: ctx.shop.id,
      conversationKey: ctx.conversationKey,
      usedAt: null,
      createdAt: { gte: new Date(Date.now() - 6 * 3600_000) },
    },
    orderBy: { createdAt: "asc" },
    take: 6,
  });
  if (!assets.length) {
    return {
      status: "no_photos",
      message:
        "No new photos found. Ask the merchant to send the product photos first.",
    };
  }

  // 1. Images: store copy (2048px) and vision copy (768px).
  const processed = await Promise.all(
    assets.map(async (asset) => {
      const base = sharp(Buffer.from(asset.data)).rotate();
      const web = await base
        .clone()
        .resize({
          width: 2048,
          height: 2048,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      const vision = await base
        .clone()
        .resize({
          width: 768,
          height: 768,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
      return { id: asset.id, web, vision, caption: asset.caption };
    }),
  );

  // 2. Listing copy from the photos and the merchant's words.
  const memory = (ctx.shop.memory as Record<string, string>) ?? {};
  const parts: Part[] = [
    ...processed.map((p) => ({
      type: "image" as const,
      mediaType: "image/jpeg" as const,
      data: p.vision.toString("base64"),
    })),
    {
      type: "text",
      text: [
        `Store: ${ctx.shop.name ?? ctx.shop.shopDomain}`,
        memory.brand_voice ? `Brand voice: ${memory.brand_voice}` : "",
        `Merchant said: ${String(input.merchant_details ?? "")}`,
        processed.some((p) => p.caption)
          ? `Photo captions: ${processed.map((p) => p.caption ?? "").join(" | ")}`
          : "",
        `There are ${processed.length} photos.`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  const ref = modelFor("listing");
  const result = await complete(ref, {
    system: LISTING_PROMPT,
    tools: [],
    maxTokens: 4000,
    effort: "medium",
    jsonSchema: {
      name: "listing",
      schema: LISTING_SCHEMA as unknown as Record<string, unknown>,
    },
    messages: [{ role: "user", parts }],
  });
  await recordUsage(
    ctx.shop.id,
    null,
    "listing",
    result,
    costUsd(result.provider, result.model, result.usage),
  );
  let listing: Listing;
  try {
    listing = JSON.parse(textOf(result.parts));
  } catch {
    return {
      status: "error",
      message: "Could not write the listing. Try again.",
    };
  }

  // 3. Upload images to Shopify (staged uploads).
  const sources = await stagedUpload(
    ctx,
    processed.map((p, i) => ({
      data: p.web,
      filename: `product-${i + 1}.jpg`,
    })),
  );

  // 4. Create the draft product with options and images.
  const options =
    (input.options as { name: string; values: string[] }[] | undefined)?.filter(
      (o) => o.values?.length,
    ) ?? [];
  const vendor = memory.default_vendor || ctx.shop.name || undefined;
  const created = await ctx.api.mutate<{
    productCreate: {
      product: {
        id: string;
        handle: string;
        title: string;
        variants: { nodes: { id: string; inventoryItem: { id: string } }[] };
      };
    };
  }>(Q.PRODUCT_CREATE, {
    product: {
      title: listing.title.slice(0, 255),
      descriptionHtml: listing.description_html,
      productType: listing.product_type,
      vendor,
      tags: listing.tags.slice(0, 12),
      seo: {
        title: listing.seo_title.slice(0, 70),
        description: listing.seo_description.slice(0, 320),
      },
      status: "DRAFT",
      ...(options.length
        ? {
            productOptions: options.map((o) => ({
              name: o.name,
              values: o.values.map((name) => ({ name })),
            })),
          }
        : {}),
    },
    media: sources.map((src, i) => ({
      originalSource: src,
      alt: listing.alt_texts[i] ?? listing.title,
      mediaContentType: "IMAGE",
    })),
  });
  const product = created.productCreate.product;

  // 5. Variants, price and stock.
  const price = String(input.price);
  const compareAtPrice =
    input.compare_at_price !== undefined
      ? String(input.compare_at_price)
      : undefined;
  const stock =
    input.stock_per_variant !== undefined
      ? Number(input.stock_per_variant)
      : undefined;
  const location =
    stock !== undefined
      ? (
          await ctx.api.query<{ locations: { nodes: { id: string }[] } }>(
            Q.PRIMARY_LOCATION,
          )
        ).locations.nodes[0]
      : undefined;
  const variantCount = await createVariants(ctx, product, options, {
    price,
    compareAtPrice,
    stock,
    locationId: location?.id,
  });

  await db.mediaAsset.updateMany({
    where: { id: { in: processed.map((p) => p.id) } },
    data: { usedAt: new Date() },
  });
  await db.auditEvent.create({
    data: {
      shopId: ctx.shop.id,
      actor: "agent",
      waId: ctx.actor.waId ?? null,
      tool: "prepare_product_listing",
      summary: `Created draft “${product.title}”`,
      undoOps: [{ query: Q.PRODUCT_DELETE, variables: { id: product.id } }],
    },
  });

  // 6. Preview image + automatic Publish approval.
  const previewId = await uploadMedia(processed[0].web, "image/jpeg").catch(
    () => null,
  );
  if (previewId) {
    ctx.previews = ctx.previews ?? [];
    ctx.previews.push({
      mediaId: previewId,
      caption: `${product.title} · ${formatMoney(price, ctx.shop.currencyCode)}`,
    });
  }
  const publishPlan = await planPublish(ctx, product.id, "publish");
  let approval: string | null = null;
  if ("ops" in publishPlan) {
    publishPlan.summary = `Publish “${product.title}” at ${formatMoney(price, ctx.shop.currencyCode)}`;
    approval = (await createPendingAction(ctx, publishPlan, "member"))
      .approvalCode;
  }

  return {
    status: "draft_created",
    title: product.title,
    price: formatMoney(price, ctx.shop.currencyCode),
    variants: variantCount,
    photos: sources.length,
    admin_url: adminUrl(
      ctx.shop.shopDomain,
      `products/${numericId(product.id)}`,
    ),
    assumptions: listing.assumptions,
    publish_approval_code: approval,
    note: "Tell the merchant in 1-2 lines: title, price, variants, and any assumptions. Publish/Keep as draft options are sent automatically.",
  };
}

async function stagedUpload(
  ctx: ToolContext,
  files: { data: Buffer; filename: string }[],
): Promise<string[]> {
  const res = await ctx.api.mutate<{
    stagedUploadsCreate: {
      stagedTargets: {
        url: string;
        resourceUrl: string;
        parameters: { name: string; value: string }[];
      }[];
    };
  }>(Q.STAGED_UPLOADS_CREATE, {
    input: files.map((f) => ({
      resource: "IMAGE",
      filename: f.filename,
      mimeType: "image/jpeg",
      httpMethod: "POST",
      fileSize: String(f.data.length),
    })),
  });
  const targets = res.stagedUploadsCreate.stagedTargets;
  await Promise.all(
    targets.map(async (target, i) => {
      if (target.url.startsWith("mock:")) return; // tests
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append(
        "file",
        new Blob([new Uint8Array(files[i].data)], { type: "image/jpeg" }),
        files[i].filename,
      );
      const upload = await fetch(target.url, { method: "POST", body: form });
      if (!upload.ok) throw new Error(`Image upload failed (${upload.status})`);
    }),
  );
  return targets.map((t) => t.resourceUrl);
}

async function createVariants(
  ctx: ToolContext,
  product: {
    id: string;
    variants: { nodes: { id: string; inventoryItem: { id: string } }[] };
  },
  options: { name: string; values: string[] }[],
  v: {
    price: string;
    compareAtPrice?: string;
    stock?: number;
    locationId?: string;
  },
): Promise<number> {
  const stockInput =
    v.stock !== undefined && v.locationId
      ? {
          inventoryQuantities: [
            { availableQuantity: v.stock, locationId: v.locationId },
          ],
        }
      : {};
  if (!options.length) {
    const variant = product.variants.nodes[0];
    await ctx.api.mutate(Q.VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: [
        {
          id: variant.id,
          price: v.price,
          ...(v.compareAtPrice ? { compareAtPrice: v.compareAtPrice } : {}),
          inventoryItem: { tracked: true },
        },
      ],
    });
    if (v.stock !== undefined && v.locationId) {
      await ctx.api.mutate(Q.INVENTORY_SET, {
        input: {
          name: "available",
          reason: "correction",
          quantities: [
            {
              inventoryItemId: variant.inventoryItem.id,
              locationId: v.locationId,
              quantity: v.stock,
              changeFromQuantity: null,
            },
          ],
        },
      });
    }
    return 1;
  }
  const combos = cartesian(
    options.map((o) =>
      o.values.map((value) => ({ optionName: o.name, name: value })),
    ),
  ).slice(0, 100);
  await ctx.api.mutate(Q.VARIANTS_BULK_CREATE, {
    productId: product.id,
    variants: combos.map((optionValues) => ({
      optionValues,
      price: v.price,
      ...(v.compareAtPrice ? { compareAtPrice: v.compareAtPrice } : {}),
      inventoryItem: { tracked: true },
      ...stockInput,
    })),
  });
  return combos.length;
}

export function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>(
    (acc, list) =>
      acc.flatMap((prefix) => list.map((item) => [...prefix, item])),
    [[]],
  );
}
