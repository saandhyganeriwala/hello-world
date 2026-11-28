/**
 * Sample data for the development-only screen previews under /dev/preview/*.
 * Lets designers and reviewers see every screen without a Shopify store or database.
 */
const now = Date.now();
const iso = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();

const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><path d="M0 0h7v7H0zM22 0h7v7h-7zM0 22h7v7H0z" fill="#000"/><path d="M1 1h5v5H1zM23 1h5v5h-5zM1 23h5v5H1z" fill="#fff"/><path d="M2 2h3v3H2zM24 2h3v3h-3zM2 24h3v3H2zM9 1h2v2H9zM13 0h1v4h-1zM16 2h3v1h-3zM9 9h4v2H9zM15 9h2v4h-2zM19 10h3v1h-3zM9 14h1v5H9zM12 13h3v3h-3zM18 14h4v2h-4zM23 12h3v1h-3zM10 22h4v1h-4zM16 18h2v6h-2zM20 19h5v1h-5zM22 23h3v3h-3zM12 26h4v2h-4zM26 26h3v3h-3zM24 15h4v1h-4z" fill="#000"/></svg>`;

const groupQr = qr;

const base = {
  plan: "solo" as string,
  planName: "Solo" as string | null,
  groupPlan: false,
  group: null as null | {
    status: "creating" | "active" | "failed";
    subject: string;
    inviteLink: string | null;
    qrSvg: string | null;
    error: string | null;
    max: number;
    participants: { id: string; label: string; joinedAt: string }[];
  },
  shopName: "Kavya Ethnic Wear",
  chatUrl: "https://wa.me/919810000000",
  embedUrl:
    "https://example.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=abc%2Fbanner-embed",
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
  recent: [] as {
    id: string;
    summary: string;
    status: string;
    createdAt: string;
  }[],
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
    {
      id: "1",
      summary: "Published “Cotton Kurta – Indigo Block Print”",
      status: "done",
      createdAt: iso(12),
    },
    {
      id: "2",
      summary: "Free shipping on orders above ₹999",
      status: "done",
      createdAt: iso(95),
    },
    {
      id: "3",
      summary: "Created draft “Banarasi Silk Saree – Maroon”",
      status: "done",
      createdAt: iso(240),
    },
    {
      id: "4",
      summary: "Raised prices of 6 sarees by 10%",
      status: "undone",
      createdAt: iso(1500),
    },
  ],
};

export const homeGroup = {
  ...homeActive,
  plan: "group",
  planName: "Group",
  groupPlan: true,
  pendingCount: 0,
  embedEnabled: true,
  group: {
    status: "active" as const,
    subject: "Kavya Ethnic Wear × Storemate",
    inviteLink: "https://chat.whatsapp.com/Fq3kP9xLm2Z",
    qrSvg: groupQr,
    error: null,
    max: 8,
    participants: [
      { id: "g1", label: "Kavya", joinedAt: iso(300) },
      { id: "g2", label: "+91 ••••• 7731", joinedAt: iso(200) },
    ],
  },
};

export const homeGroupNew = {
  ...homeGroup,
  embedEnabled: false,
  group: null,
};

export const plan = {
  plan: "solo",
  planUrl: "#",
  plans: [
    {
      id: "solo",
      name: "Solo",
      price: 5.99,
      tagline: "Run your store from your own WhatsApp.",
      features: [
        "One WhatsApp number",
        "Add products from photos",
        "Prices, stock, shipping, discounts and banners",
        "Ask about sales any time",
      ],
    },
    {
      id: "group",
      name: "Group",
      price: 9.99,
      tagline: "Your whole team in one WhatsApp group with Storemate.",
      features: [
        "Everything in Solo",
        "A WhatsApp group for your team (up to 8 people)",
        "Up to 8 numbers can also chat one-to-one",
        "Daily or weekly sales summaries",
        "Abandoned checkout follow-up drafts",
      ],
    },
  ],
};

export const activity = {
  pending: [
    {
      id: "p1",
      summary: "Add banner: “Diwali sale – 20% off till Sunday”",
      diffText:
        "Banner: off → on\nText: “Diwali sale – 20% off till Sunday”\nShows until: Sun 1 Dec, 11:59 pm",
      createdAt: iso(4),
      expiresAt: new Date(now + 23 * 3_600_000).toISOString(),
    },
  ],
  events: [
    {
      id: "1",
      summary: "Published “Cotton Kurta – Indigo Block Print”",
      actor: "agent",
      status: "done",
      canUndo: true,
      createdAt: iso(12),
    },
    {
      id: "2",
      summary: "Free shipping on orders above ₹999",
      actor: "agent",
      status: "done",
      canUndo: true,
      createdAt: iso(95),
    },
    {
      id: "3",
      summary: "Created draft “Banarasi Silk Saree – Maroon”",
      actor: "agent",
      status: "done",
      canUndo: false,
      createdAt: iso(240),
    },
    {
      id: "4",
      summary: "Raised prices of 6 sarees by 10%",
      actor: "agent",
      status: "undone",
      canUndo: false,
      createdAt: iso(1500),
    },
    {
      id: "5",
      summary: "Connected a WhatsApp number",
      actor: "merchant",
      status: "done",
      canUndo: false,
      createdAt: iso(2900),
    },
  ],
};

export const settings = {
  plan: "solo",
  planName: "Solo",
  features: { group: false, summaries: false, checkoutRecovery: false },
  numberLimit: 1,
  group: null as (typeof homeGroup)["group"] | null,
  settings: {
    language: "auto",
    approvalMode: "standard",
    summaryFrequency: "weekly",
    weeklySummaryDay: 1,
    summaryHour: 9,
    checkoutDigestEnabled: true,
    updatesDestination: "group",
  },
  users: [
    {
      id: "u1",
      phone: "+91 ••••• 5210",
      name: "Kavya",
      role: "owner",
      linkedAt: iso(2900),
    },
  ],
  connect: null,
  planUrl: "#",
  supportEmail: "support@example.com",
  allowSimulate: false,
};

export const settingsGroup = {
  ...settings,
  plan: "group",
  planName: "Group",
  features: { group: true, summaries: true, checkoutRecovery: true },
  numberLimit: 8,
  group: homeGroup.group,
  users: [
    {
      id: "u1",
      phone: "+91 ••••• 5210",
      name: "Kavya",
      role: "owner",
      linkedAt: iso(2900),
    },
    {
      id: "u2",
      phone: "+91 ••••• 7731",
      name: "Rohit",
      role: "staff",
      linkedAt: iso(1200),
    },
  ],
};
