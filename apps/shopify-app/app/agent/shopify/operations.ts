/**
 * Every Admin GraphQL document the agent uses. All of them are validated against the pinned
 * Admin API schema in tests (operations.test.ts), so a field or argument that does not exist fails CI.
 */

export const SHOP_CONTEXT = `#graphql
  query ShopContext {
    shop { name currencyCode ianaTimezone myshopifyDomain primaryDomain { url } }
    currentAppInstallation { id }
    publications(first: 20) { nodes { id name } }
  }`;

export const SEARCH_PRODUCTS = `#graphql
  query SearchProducts($first: Int!, $query: String) {
    products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id title handle status totalInventory onlineStoreUrl
        priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
      }
    }
  }`;

export const GET_PRODUCT = `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      id title handle status descriptionHtml productType vendor tags onlineStoreUrl totalInventory
      seo { title description }
      options { name values }
      variants(first: 50) {
        nodes { id title price compareAtPrice sku inventoryQuantity inventoryItem { id } }
      }
      media(first: 10) { nodes { ... on MediaImage { id image { url altText } } } }
      collections(first: 10) { nodes { id title } }
    }
  }`;

export const PRODUCT_VARIANT_PRICES = `#graphql
  query ProductVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id title status
        variants(first: 100) { nodes { id title price compareAtPrice } }
      }
    }
  }`;

export const PRODUCT_SNAPSHOT = `#graphql
  query ProductSnapshot($id: ID!) {
    product(id: $id) {
      id title status descriptionHtml productType vendor tags
      seo { title description }
    }
  }`;

export const ORDERS_IN_RANGE = `#graphql
  query OrdersInRange($query: String!, $after: String) {
    orders(first: 250, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt cancelledAt displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount } }
        lineItems(first: 20) { nodes { title quantity } }
      }
    }
  }`;

export const ABANDONED_CHECKOUTS_WITH_CUSTOMER = `#graphql
  query AbandonedCheckoutsWithCustomer($first: Int!, $query: String) {
    abandonedCheckouts(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id createdAt abandonedCheckoutUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 5) { nodes { title quantity } }
        customer { firstName defaultPhoneNumber { phoneNumber } }
      }
    }
  }`;

export const ABANDONED_CHECKOUTS = `#graphql
  query AbandonedCheckouts($first: Int!, $query: String) {
    abandonedCheckouts(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id createdAt abandonedCheckoutUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 5) { nodes { title quantity } }
      }
    }
  }`;

export const DELIVERY_PROFILES = `#graphql
  query DeliveryProfiles {
    deliveryProfiles(first: 5) {
      nodes {
        id name default
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 20) {
            nodes {
              zone { id name countries { name code { countryCode restOfWorld } } }
              methodDefinitions(first: 20) {
                nodes {
                  id name active
                  rateProvider {
                    ... on DeliveryRateDefinition { id price { amount currencyCode } }
                    ... on DeliveryParticipant { id }
                  }
                  methodConditions {
                    field operator
                    conditionCriteria {
                      __typename
                      ... on MoneyV2 { amount currencyCode }
                      ... on Weight { value unit }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

export const DELIVERY_PROFILE_UPDATE = `#graphql
  mutation DeliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id }
      userErrors { field message }
    }
  }`;

export const PRIMARY_LOCATION = `#graphql
  query PrimaryLocation {
    locations(first: 1, query: "active:true") { nodes { id name } }
  }`;

export const STAGED_UPLOADS_CREATE = `#graphql
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

export const PRODUCT_CREATE = `#graphql
  mutation ProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id handle title variants(first: 1) { nodes { id inventoryItem { id } } } }
      userErrors { field message }
    }
  }`;

export const VARIANTS_BULK_CREATE = `#graphql
  mutation VariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
      productVariants { id title inventoryItem { id } }
      userErrors { field message }
    }
  }`;

export const VARIANTS_BULK_UPDATE = `#graphql
  mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }`;

export const PRODUCT_UPDATE = `#graphql
  mutation ProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id status }
      userErrors { field message }
    }
  }`;

export const PRODUCT_DELETE = `#graphql
  mutation ProductDelete($id: ID!) {
    productDelete(input: { id: $id }) {
      deletedProductId
      userErrors { field message }
    }
  }`;

export const PUBLISHABLE_PUBLISH = `#graphql
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

export const PUBLISHABLE_UNPUBLISH = `#graphql
  mutation PublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

export const INVENTORY_SET = `#graphql
  mutation InventorySet($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message }
    }
  }`;

export const VARIANT_STOCK = `#graphql
  query VariantStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id title inventoryQuantity product { title } inventoryItem { id } }
    }
  }`;

export const DISCOUNT_CODE_BASIC_CREATE = `#graphql
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_BASIC_CREATE = `#graphql
  mutation DiscountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_CODE_FREE_SHIPPING_CREATE = `#graphql
  mutation DiscountCodeFreeShippingCreate($freeShippingCodeDiscount: DiscountCodeFreeShippingInput!) {
    discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_FREE_SHIPPING_CREATE = `#graphql
  mutation DiscountAutomaticFreeShippingCreate($freeShippingAutomaticDiscount: DiscountAutomaticFreeShippingInput!) {
    discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: $freeShippingAutomaticDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_CODE_DEACTIVATE_BY_CODE = `#graphql
  query DiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) { id }
  }`;

export const DISCOUNT_CODE_DEACTIVATE = `#graphql
  mutation DiscountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_DEACTIVATE = `#graphql
  mutation DiscountAutomaticDeactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const APP_METAFIELD = `#graphql
  query AppBannerMetafield {
    currentAppInstallation {
      id
      metafield(namespace: "banner", key: "config") { value }
    }
  }`;

export const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }`;

export const PAGE_GET = `#graphql
  query PageGet($id: ID!) {
    page(id: $id) { id title body isPublished }
  }`;

export const PAGE_CREATE = `#graphql
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }`;

export const PAGE_UPDATE = `#graphql
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle }
      userErrors { field message }
    }
  }`;

export const PAGE_DELETE = `#graphql
  mutation PageDelete($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message }
    }
  }`;

/** Mutations the generic GraphQL tool may propose (always with merchant approval). */
export const GENERIC_MUTATION_ALLOWLIST = new Set([
  "productUpdate",
  "productVariantsBulkUpdate",
  "collectionCreate",
  "collectionUpdate",
  "collectionAddProducts",
  "collectionRemoveProducts",
  "metafieldsSet",
  "pageUpdate",
  "articleCreate",
  "articleUpdate",
  "urlRedirectCreate",
  "menuUpdate",
  "tagsAdd",
  "tagsRemove",
  "productReorderMedia",
  "fileUpdate",
  "inventorySetQuantities",
  "discountCodeDeactivate",
  "discountAutomaticDeactivate",
  "locationLocalPickupEnable",
  "locationLocalPickupDisable",
]);
