import { adminUrl } from "../util";

/**
 * Curated steps for tasks Shopify offers no API for (rung c of the fallback ladder).
 * Every request that lands here is logged, so the most common ones can become real tools later.
 */
const PLAYBOOKS: Record<
  string,
  { title: string; path: string; steps: string[] }
> = {
  theme_design: {
    title: "Change theme colours, fonts or layout",
    path: "themes/current/editor",
    steps: [
      "Open the theme editor with the link below.",
      "Click the paint-brush (Theme settings) icon on the left.",
      "Pick Colors or Typography and make your change.",
      "Click Save at the top right.",
    ],
  },
  app_install: {
    title: "Install another app",
    path: "apps",
    steps: [
      "Open the Shopify App Store link below and search for the app.",
      "Click Install and review the permissions it asks for.",
      "Approve the install. Only you can approve apps for your store.",
    ],
  },
  payments: {
    title: "Payment settings",
    path: "settings/payments",
    steps: [
      "Open Payments with the link below.",
      "Choose or change your payment provider.",
      "Follow Shopify's verification steps.",
    ],
  },
  domains: {
    title: "Connect or change a domain",
    path: "settings/domains",
    steps: [
      "Open Domains with the link below.",
      "Click Connect existing domain or Buy new domain.",
      "Follow the on-screen steps.",
    ],
  },
  store_password: {
    title: "Turn the store password on or off",
    path: "online_store/preferences",
    steps: [
      "Open Preferences with the link below.",
      "Scroll to Password protection.",
      "Tick or untick Restrict access, then Save.",
    ],
  },
  notifications: {
    title: "Edit customer notification emails",
    path: "settings/notifications",
    steps: [
      "Open Notifications with the link below.",
      "Choose the email to edit (for example Order confirmation).",
      "Click Edit code, change the text, Save.",
    ],
  },
  checkout: {
    title: "Checkout settings",
    path: "settings/checkout",
    steps: [
      "Open Checkout with the link below.",
      "Change the setting you need.",
      "Click Save.",
    ],
  },
  taxes: {
    title: "Taxes and duties",
    path: "settings/taxes",
    steps: [
      "Open Taxes and duties with the link below.",
      "Choose your country and review the settings.",
      "Click Save.",
    ],
  },
  staff: {
    title: "Staff accounts",
    path: "settings/account",
    steps: [
      "Open Users and permissions with the link below.",
      "Add staff or change permissions.",
      "Only the store owner can do this.",
    ],
  },
  other: {
    title: "Shopify settings",
    path: "settings",
    steps: ["Open Settings with the link below and find the section you need."],
  },
};

export function guidedSteps(shopDomain: string, topic: string, task: string) {
  const playbook = PLAYBOOKS[topic] ?? PLAYBOOKS.other;
  return {
    status: "guided",
    task,
    title: playbook.title,
    link:
      topic === "app_install"
        ? "https://apps.shopify.com/"
        : adminUrl(shopDomain, playbook.path),
    steps: playbook.steps,
    note: "This can't be done through Shopify's API, so the merchant does it. Send the numbered steps and the link, briefly.",
  };
}
