/**
 * Sample data for the development-only screen previews under /dev/preview/*.
 * Lets designers and reviewers see every screen without a Shopify store or database.
 */
const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path d="M0 0h7v7H0zM22 0h7v7h-7zM0 22h7v7H0z" fill="#000"/><path d="M1 1h5v5H1zM23 1h5v5h-5zM1 23h5v5H1z" fill="#fff"/><path d="M2 2h3v3H2zM24 2h3v3h-3zM2 24h3v3H2zM9 1h2v2H9zM13 0h1v4h-1zM16 2h3v1h-3zM9 9h4v2H9zM15 9h2v4h-2zM19 10h3v1h-3zM9 14h1v5H9zM12 13h3v3h-3zM18 14h4v2h-4zM23 12h3v1h-3zM10 22h4v1h-4zM16 18h2v6h-2zM20 19h5v1h-5zM22 23h3v3h-3zM12 26h4v2h-4zM26 26h3v3h-3zM24 15h4v1h-4z" fill="#000"/></svg>`;

const base = {
  shopName: "Kavya Ethnic Wear",
  chatUrl: "https://wa.me/919810000000",
  embedUrl: "https://example.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=abc%2Fbanner-embed",
  setupDismissed: false,
  allowSimulate: false,
};

export const homeNew = {
  ...base,
  connected: false,
  linkedCount: 0,
  ownerPhone: null,
  connect: {
    code: "7F3K9Q",
    url: "https://wa.me/919810000000?text=Hi%20Storemate",
    text: "Hi Storemate, connect my store. Code: LINK-7F3K9Q",
    displayNumber: "+91 98100 00000",
    qrSvg: qr,
    expiresAt: new Date(now + 9 * 60_000).toISOString(),
  },
  embedEnabled: false,
  storefrontSkipped: false,
  stats: { messages: 0, changes: 0, products: 0, budgetUsedPercent: 0 },
  pendingCount: 0,
  recent: [] as { id: string; summary: string; status: string; createdAt: string }[],
};

export const homeActive = {
  ...base,
  connected: true,
  linkedCount: 2,
  ownerPhone: "+91 ••••• 5210",
  connect: null,
  embedEnabled: false,
  storefrontSkipped: false,
  stats: { messages: 86, changes: 23, products: 14, budgetUsedPercent: 31 },
  pendingCount: 1,
  recent: [
    { id: "1", summary: "Published “Cotton Kurta – Indigo Block Print”", status: "done", createdAt: iso(12) },
    { id: "2", summary: "Free shipping on orders above ₹999", status: "done", createdAt: iso(95) },
    { id: "3", summary: "Created draft “Banarasi Silk Saree – Maroon”", status: "done", createdAt: iso(240) },
    { id: "4", summary: "Raised prices of 6 sarees by 10%", status: "undone", createdAt: iso(1500) },
  ],
};

export const activity = {
  pending: [
    {
      id: "p1",
      summary: "Add banner: “Diwali sale – 20% off till Sunday”",
      diffText: "Banner: off → on\nText: “Diwali sale – 20% off till Sunday”\nShows until: Sun 1 Dec, 11:59 pm",
      createdAt: iso(4),
      expiresAt: new Date(now + 23 * 3_600_000).toISOString(),
    },
  ],
  events: [
    { id: "1", summary: "Published “Cotton Kurta – Indigo Block Print”", actor: "agent", status: "done", canUndo: true, createdAt: iso(12) },
    { id: "2", summary: "Free shipping on orders above ₹999", actor: "agent", status: "done", canUndo: true, createdAt: iso(95) },
    { id: "3", summary: "Created draft “Banarasi Silk Saree – Maroon”", actor: "agent", status: "done", canUndo: false, createdAt: iso(240) },
    { id: "4", summary: "Raised prices of 6 sarees by 10%", actor: "agent", status: "undone", canUndo: false, createdAt: iso(1500) },
    { id: "5", summary: "Connected a WhatsApp number", actor: "merchant", status: "done", canUndo: false, createdAt: iso(2900) },
  ],
};

export const settings = {
  settings: { language: "auto", approvalMode: "standard", weeklySummaryEnabled: true, weeklySummaryDay: 1, checkoutDigestEnabled: true },
  users: [
    { id: "u1", phone: "+91 ••••• 5210", name: "Kavya", role: "owner", linkedAt: iso(2900) },
    { id: "u2", phone: "+91 ••••• 7731", name: "Rohit", role: "staff", linkedAt: iso(1200) },
  ],
  connect: null,
  planUrl: "#",
  supportEmail: "support@example.com",
  allowSimulate: false,
};
