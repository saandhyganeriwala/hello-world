# 3. Shopify GraphQL Admin API Surface

Pin one API version, the latest stable release when the build starts (for example `2026-10`), in
`shopify.app.toml` and in the GraphQL client. Upgrade each quarter. Every field below must be
checked against the pinned version's schema in CI, using `graphql-js` `validate()` against the
introspected Admin schema. That check also guards the generic GraphQL tool.

## 3.1 Operations by feature

### Products and images

| Purpose | Operation | Notes |
|---|---|---|
| Create product | `productCreate(product: ProductCreateInput!, media: [CreateMediaInput!])` | Create with `status: DRAFT`. Set `title`, `descriptionHtml`, `productType`, `vendor`, `tags`, `seo { title description }`, `handle`, `productOptions`. |
| Multi-variant upsert (alternative) | `productSet(input: ProductSetInput!, synchronous: true)` | Declarative: one call sets options, variants and prices. Good for idempotent retries. |
| Variants and price | `productVariantsBulkCreate(productId, variants, strategy: REMOVE_STANDALONE_VARIANT)`, `productVariantsBulkUpdate(productId, variants)` | `price`, `compareAtPrice`, `inventoryItem { sku tracked }`. |
| Option management | `productOptionsCreate`, `productOptionUpdate` | Sizes and colours. |
| Image upload | `stagedUploadsCreate(input: [{resource: IMAGE, filename, mimeType, httpMethod: POST, fileSize}])` → multipart POST to `url` → `resourceUrl` used as `originalSource` | |
| Attach media | `productCreate(media:)` / `productUpdate(product:, media:)` with `CreateMediaInput {originalSource, alt, mediaContentType: IMAGE}`; or `fileCreate` + `fileUpdate(referencesToAdd)` | Poll `product.media { status }` until `READY`. Alt text comes from the listing call. |
| Reorder/delete media | `productReorderMedia`, `fileUpdate(referencesToRemove)`, `fileDelete` | Delete is tier D. |
| Update product | `productUpdate(product: ProductUpdateInput!)` | Status `ACTIVE`, `DRAFT` or `ARCHIVED`. |
| Publish to Online Store | `publications(first: 20) { nodes { id name } }` → `publishablePublish(id, input: [{publicationId}])`; `publishableUnpublish` | Cache the Online Store publication id per shop. |
| Delete | `productDelete(input: {id})`, `productVariantsBulkDelete` | Tier D. |
| Inventory | `locations(first:)`, `inventorySetQuantities(input: {name: "available", reason: "correction", quantities: [...]})` | |
| Collections | `collections(query:)`, `collectionCreate`, `collectionAddProducts`, `collectionRemoveProducts` | |
| Product metafields | `metafieldsSet(metafields: [...])` | Material, care instructions and similar. |
| Read and search | `products(first:, query:)`, `product(id:)`, `productByIdentifier(identifier: {handle})` | |
| Bulk changes | `bulkOperationRunQuery`, `bulkOperationRunMutation` (with `stagedUploadsCreate` JSONL) | Price changes across more than about 50 products. |

### Store configuration

| Purpose | Operation | Notes |
|---|---|---|
| Shipping read | `deliveryProfiles(first:) { profileLocationGroups { locationGroupZones { zone { countries } methodDefinitions { name rateProvider active } } } }` | |
| Shipping write | `deliveryProfileUpdate(id, profile: DeliveryProfileInput)` (`locationGroupsToUpdate`, `zonesToCreate`, `zonesToUpdate`, `methodDefinitionsToCreate`/`Update`, `methodDefinitionsToDelete`), `deliveryProfileCreate` | "Free above ₹999" means a method definition with a price condition `>= 999` and rate 0, plus the existing paid rate with condition `< 999`. Tier C. |
| Local pickup | `locationLocalPickupEnable`, `locationLocalPickupDisable` | |
| Discounts | `discountCodeBasicCreate`, `discountAutomaticBasicCreate`, `discountCodeFreeShippingCreate`, `discountCodeDeactivate`, `codeDiscountNodes(query:)` | Tier C. Also used for checkout-recovery codes. |
| Banner / promo bar | `metafieldsSet` on the **AppInstallation** owner (`currentAppInstallation { id }`), namespace `banner`, type `json` | Read in the Theme App Extension as `app.metafields.banner.config`. No theme write needed. See doc 07. |
| Other storefront sections | App-owned metaobjects (`metaobjectUpsert`) declared in `shopify.app.toml`, rendered by app blocks | For example a featured-products strip or a trust-badges block. |
| Is the app block installed? | `themes(roles: MAIN) { nodes { id files(filenames: ["templates/index.json", "config/settings_data.json"]) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } } }` | Read-only (`read_themes`). Used to decide between "update data" and "send the theme editor deep link". |
| Pages | `pageCreate`, `pageUpdate`, `pages(query:)` | About, shipping policy page, size guide. |
| Blog | `articleCreate`, `articleUpdate`, `blogs` | Optional. |
| Navigation | `menus`, `menuUpdate` | Tier C. |
| Redirects | `urlRedirectCreate` | Tier B. |
| Legal policies | `shopPolicyUpdate` | Tier C, optional scope. |
| Shop info | `shop { name currencyCode ianaTimezone primaryDomain { url } plan { publicDisplayName } }` | Cached into the merchant context. |

### Orders, analytics, abandoned checkouts

| Purpose | Operation | Notes |
|---|---|---|
| Weekly summary | `orders(first: 250, query: "created_at:>=… created_at:<…", sortKey: CREATED_AT)` selecting `totalPriceSet`, `subtotalPriceSet`, `totalDiscountsSet`, `displayFinancialStatus`, `lineItems(first: 20) { title quantity }`, `customer { numberOfOrders }` | Paginate, or use `bulkOperationRunQuery` for large shops. Without `read_all_orders` only the last 60 days are visible, which is enough for weekly reporting. |
| Sessions and conversion | `shopifyqlQuery` (`read_reports`), **if available in the pinned version** | If it is not available, summaries cover orders, revenue, AOV, top products, repeat-customer share and checkout recovery only. |
| Abandoned checkouts | `abandonedCheckouts(first:, query: "created_at:>=…", sortKey: CREATED_AT)` selecting `id`, `abandonedCheckoutUrl`, `createdAt`, `totalPriceSet`, `lineItems(first: 5) { title quantity }`, `customer { firstName defaultPhoneNumber { phoneNumber marketingState } }` | Customer name and phone are **protected customer data (level 2)**. That needs an approved request in the Partner Dashboard. |
| Real-time triggers (optional) | Webhooks `checkouts/create`, `checkouts/update`, `orders/create` | Run the daily batch first. Real-time comes later. |

### App lifecycle and billing

| Purpose | Operation |
|---|---|
| Subscription | **Managed Pricing** (plans defined in the Partner Dashboard; Shopify hosts the plan page). Alternative: `appSubscriptionCreate` with `appRecurringPricingDetails` plus a usage line item (`appUsagePricingDetails` with `cappedAmount`) for over-quota computer use or premium copy. |
| Check plan | `currentAppInstallation { id activeSubscriptions { name status currentPeriodEnd } }` |
| Usage charges | `appUsageRecordCreate(subscriptionLineItemId, price, description, idempotencyKey)` |
| Optional scopes at runtime | App Bridge `shopify.scopes.request([...])` for scopes in `optional_scopes` |

### Webhook topics (declared in `shopify.app.toml`)

`app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, `shop/update`, compliance topics
`customers/data_request`, `customers/redact`, `shop/redact` (mandatory), and optional
`checkouts/create`, `checkouts/update`, `orders/create`.

## 3.2 Access scopes

Ask for the minimum at install. Request the rest as **optional scopes** when a feature is first used.
That makes the install screen less alarming and gives each scope a clear reason during review.

| Scope | When | Used for |
|---|---|---|
| `read_products`, `write_products` | Install | Products, variants, media, collections, product metafields |
| `read_publications`, `write_publications` | Install | Publishing to the Online Store |
| `read_inventory`, `write_inventory`, `read_locations` | Install | Stock levels |
| `read_orders` | Install | Weekly summaries, abandoned checkouts (verify that the pinned version needs no other scope for `abandonedCheckouts`) |
| `read_themes` | Install | Read-only check that the app block or embed is installed |
| `read_shipping`, `write_shipping` | Optional | Delivery profiles and rates |
| `read_discounts`, `write_discounts` | Optional | Discounts, recovery codes |
| `read_online_store_pages`, `write_online_store_pages` | Optional | Pages |
| `read_online_store_navigation`, `write_online_store_navigation` | Optional | Menus, redirects |
| `read_content`, `write_content` | Optional | Blogs and articles |
| `read_customers` | Optional | Customer names and phones for recovery drafts (plus protected customer data approval) |
| `read_reports` | Optional | ShopifyQL, where available |
| `write_legal_policies` | Optional | Policy pages |

**Not requested:** `write_themes` (theme code edits need a Shopify exemption and conflict with App Store
rules), `read_all_orders` (needs approval and is not required), anything to do with payments, checkout
settings or staff.

## 3.3 Rate limits (calculated query cost)

Shopify's GraphQL Admin API uses a leaky bucket measured in cost points per shop and app. The restore
rate depends on the merchant's plan (roughly 100 points/s on standard plans, more on Advanced and Plus),
and a single query may not exceed 1,000 points. **Do not hard-code these numbers.** Read them from each
response:

```json
"extensions": { "cost": {
  "requestedQueryCost": 112, "actualQueryCost": 38,
  "throttleStatus": { "maximumAvailable": 2000, "currentlyAvailable": 1962, "restoreRate": 100 } } }
```

Client design (`packages/shopify/graphql.ts`):

1. A per-shop bucket mirror in memory (with a Postgres fallback) is updated from `throttleStatus` after every call.
2. Before a call, estimate the cost from the last `requestedQueryCost` for that operation name (cached),
   and wait for `(estimate - available) / restoreRate` seconds if needed.
3. On a `THROTTLED` error, use exponential backoff with jitter, at most 5 attempts, then fail the tool with a clear message.
4. Keep query costs low by limiting `first:` sizes (≤ 50 for nested connections), selecting only the fields
   needed, and using bulk operations for anything larger than about 250 nodes.
5. For the generic GraphQL tool, reject queries whose `requestedQueryCost` would exceed 500. Use the static
   cost estimate (`Shopify-GraphQL-Cost-Debug: 1` in dev) and suggest a bulk operation instead.
6. Retry mutations only with an idempotency guard: check by handle or by the audit record before re-creating.
