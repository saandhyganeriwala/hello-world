/** Small pure helpers shared by the agent tools and summaries. */

/** Offset like "+05:30" for a time zone at a given instant. */
export function tzOffset(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return match ? `${match[1]}:${match[2] ?? "00"}` : "+00:00";
}

/** "2026-11-21" in a time zone -> ISO timestamp at local midnight, e.g. "2026-11-21T00:00:00+05:30". */
export function localMidnightIso(date: string, timeZone: string): string {
  const offset = tzOffset(timeZone, new Date(`${date}T12:00:00Z`));
  return `${date}T00:00:00${offset}`;
}

/** Today's date (YYYY-MM-DD) and weekday/hour in a time zone. */
export function localNow(timeZone: string, at: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).map((p) => [p.type, p.value]),
  );
  const weekday =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) +
    1; // 1 = Monday
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday,
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatMoney(
  amount: number | string,
  currency: string | null | undefined,
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  const code = currency || "INR";
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
}

export function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export function adminUrl(shopDomain: string, path: string): string {
  const handle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${handle}/${path.replace(/^\//, "")}`;
}

/** Rounds a new price like the old ones: whole numbers stay whole. */
export function roundPrice(value: number, wholeNumbers: boolean): string {
  const rounded = wholeNumbers
    ? Math.round(value)
    : Math.round(value * 100) / 100;
  return Math.max(0, rounded).toFixed(2);
}

export function truncateLines(lines: string[], max = 15): string {
  if (lines.length <= max) return lines.join("\n");
  return [...lines.slice(0, max), `…and ${lines.length - max} more`].join("\n");
}

/** 4-digit code merchants type to approve in groups. */
export function approvalCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}
