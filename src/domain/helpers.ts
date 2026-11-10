// Pure helpers shared by the AI pipeline, record logic and import.
import type { Fields } from "../db/schema.js";

export const KINDS = ["orders", "payments", "tasks", "crm", "inquiries", "meetings", "inventory", "generic"] as const;
export type Kind = (typeof KINDS)[number];

export const ICONS = ["package", "box", "rupee", "chat", "phone", "person", "people", "task", "truck", "calendar", "note", "clock", "star", "tag"] as const;

export const MEMBER_COLORS = ['#0B8C8C','#9A47C6','#E8870B','#12845A','#D23A2E','#97672B','#3A57D6','#C2417A'];

const KIND_MAP: Record<string, Kind> = {
  order: "orders", sale: "orders", sales: "orders", payment: "payments", invoice: "payments", ledger: "payments",
  expense: "payments", transaction: "payments", task: "tasks", todo: "tasks", "to-do": "tasks", followup: "tasks",
  "follow-up": "tasks", customer: "crm", customers: "crm", client: "crm", clients: "crm", contact: "crm",
  contacts: "crm", supplier: "crm", vendor: "crm", lead: "inquiries", leads: "inquiries", inquiry: "inquiries",
  enquiry: "inquiries", meeting: "meetings", appointment: "meetings", appointments: "meetings", visit: "meetings",
  stock: "inventory", product: "inventory", products: "inventory", item: "inventory", items: "inventory",
};

export function normKind(k: unknown): Kind | "" {
  const s = String(k ?? "").toLowerCase().trim();
  if ((KINDS as readonly string[]).includes(s)) return s as Kind;
  return KIND_MAP[s] ?? "";
}

export function inferKind(name: string): Kind {
  const n = name.toLowerCase();
  if (/order|sale/.test(n)) return "orders";
  if (/payment|invoice|ledger|transaction|expense|billing/.test(n)) return "payments";
  if (/task|to-?do|follow/.test(n)) return "tasks";
  if (/inquir|enquir|lead/.test(n)) return "inquiries";
  if (/customer|client|contact|crm|supplier|vendor/.test(n)) return "crm";
  if (/meeting|appointment|visit|event/.test(n)) return "meetings";
  if (/inventor|stock|product|item/.test(n)) return "inventory";
  return "generic";
}

const ICON_WORDS: Record<string, string> = {
  order: "package", orders: "package", package: "package", product: "box", products: "box", inventory: "box",
  stock: "box", item: "box", items: "box", inquiry: "chat", inquiries: "chat", enquiry: "chat", lead: "chat",
  leads: "chat", customer: "person", customers: "person", client: "person", clients: "person", contact: "person",
  people: "people", payment: "rupee", payments: "rupee", invoice: "rupee", invoices: "rupee", bill: "rupee",
  expense: "rupee", expenses: "rupee", sales: "rupee", revenue: "rupee", call: "phone", calls: "phone",
  task: "task", tasks: "task", todo: "task", followup: "task", reminder: "clock", reminders: "clock",
  delivery: "truck", deliveries: "truck", dispatch: "truck", shipping: "truck", shipment: "truck",
  meeting: "calendar", meetings: "calendar", appointment: "calendar", booking: "calendar", bookings: "calendar",
  note: "note", notes: "note", review: "star", reviews: "star", feedback: "star",
};

export function sectionIcon(name: string, hint?: unknown): string {
  const h = String(hint ?? "").toLowerCase().trim();
  if ((ICONS as readonly string[]).includes(h)) return h;
  if (ICON_WORDS[h]) return ICON_WORDS[h];
  for (const w of name.toLowerCase().split(/\s+/)) {
    const k = w.replace(/[^a-z-]/g, "");
    if (ICON_WORDS[k]) return ICON_WORDS[k];
    if (ICON_WORDS[k.replace(/s$/, "")]) return ICON_WORDS[k.replace(/s$/, "")];
  }
  return "tag";
}

const TITLE_KEYS = ["Title", "Name", "Customer", "Client", "Subject", "Contact", "Item", "Product"];
export const isUrl = (v: unknown) => /^https?:\/\/\S+$/i.test(String(v ?? "").trim());

/** The human label for a record (mirrors the client's recTitle). */
export function recTitle(sectionName: string, fields: Fields): string {
  const secl = sectionName.toLowerCase(), sing = secl.replace(/s$/, "");
  const bad = (v: unknown) => {
    const t = String(v ?? "").trim().toLowerCase();
    return !t || t === secl || t === sing ||
      /^(new |abandoned |pending |open |draft )?(order|checkout|cart|record|entry|inquiry|enquiry|lead|payment|invoice|task|note|item)s?\s*#?\d*$/.test(t);
  };
  for (const k of TITLE_KEYS) { const v = fields[k]; if (v && !isUrl(v) && !bad(v)) return v; }
  for (const [k, v] of Object.entries(fields)) { if (k !== "Status" && v && !isUrl(v) && !bad(v)) return v; }
  for (const k of TITLE_KEYS) if (fields[k]) return fields[k];
  return Object.entries(fields).find(([k]) => k !== "Status")?.[1] ?? "Untitled";
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export const cleanKey = (k: unknown) => {
  const s = String(k ?? "").trim().replace(/\s+/g, " ");
  return (s.length > 40 ? s.slice(0, 40) : s) || "Field";
};

const COLORS: Record<string, string> = {
  red: "#E5484D", orange: "#E8622C", amber: "#D98A20", yellow: "#CA9A04", lime: "#5BA300", green: "#1C8A57",
  emerald: "#0E9F6E", teal: "#0D9488", cyan: "#0891B2", sky: "#0EA5E9", blue: "#2F54EB", indigo: "#4F46E5",
  violet: "#7C3AED", purple: "#9333EA", fuchsia: "#C026D3", magenta: "#C026D3", pink: "#DB2777", rose: "#E11D48",
  maroon: "#9F1239", brown: "#8A5A2B", slate: "#52606D", gray: "#52606D", grey: "#52606D", black: "#2A2A26",
};
export function resolveColor(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim().toLowerCase();
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s.startsWith("#") ? s : "#" + s;
  return COLORS[s] ?? null;
}
