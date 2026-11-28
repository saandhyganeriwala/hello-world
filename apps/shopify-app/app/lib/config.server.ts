/** Server configuration read from the environment. Every value is optional in development. */
export const config = {
  shopifyApiKey: process.env.SHOPIFY_API_KEY ?? "",
  /** Optional: the theme app extension uid, to match the embed exactly in settings_data.json */
  bannerExtensionUid: process.env.SHOPIFY_BANNER_EXTENSION_UID || undefined,
  /** App handle from the Partner Dashboard, used for the Managed Pricing page link */
  appHandle: process.env.SHOPIFY_APP_HANDLE ?? "storemate",
  supportEmail: process.env.SUPPORT_EMAIL ?? "support@example.com",

  whatsapp: {
    /** Number merchants message, e.g. "+91 98100 00000". Shown in the app and used for wa.me links. */
    displayNumber: process.env.WHATSAPP_DISPLAY_NUMBER ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v24.0",
    /** Approved template names, used for business-initiated messages outside the 24-hour window. */
    templates: {
      language: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en",
      /** Body params: {{1}} store name, {{2}} period label, {{3}} revenue, {{4}} orders */
      summary: process.env.WHATSAPP_TEMPLATE_SUMMARY ?? "",
      /** Body params: {{1}} count, {{2}} total value */
      checkoutDigest: process.env.WHATSAPP_TEMPLATE_CHECKOUT_DIGEST ?? "",
      /** Meta Template Library "Group invite link" template (utility) */
      groupInvite: process.env.WHATSAPP_TEMPLATE_GROUP_INVITE ?? "",
    },
  },

  /** Monthly assistant budget per shop in USD (see docs/08-cost-model.md). */
  monthlyLlmBudgetUsd: Number(process.env.MONTHLY_LLM_BUDGET_USD ?? "2.5"),

  isProduction: process.env.NODE_ENV === "production",
};

export const whatsappSendingEnabled = () =>
  Boolean(config.whatsapp.phoneNumberId && config.whatsapp.accessToken);
