// Saved views on a section: how its records are shown (board, chart, tracker…).
// Views come from Claude, from the Customize menu, or (as defaults) from the client.
// Everything is sanitised here so a bad view can never break a screen.
import { AGGS, FILTER_OPS, VIEW_TYPES } from "../ai/schemas.js";

export type View = {
  name: string; type: (typeof VIEW_TYPES)[number];
  groupBy: string; groups: string[]; dateField: string; measure: string; agg: (typeof AGGS)[number];
  chart: string; bucket: string; fields: string[];
  filters: { field: string; op: string; value: string }[];
  sortBy: string; sortDir: string; goal: number; unit: string; period: string;
  metrics: { label: string; agg: string; field: string; filterField: string; filterOp: string; filterValue: string }[];
  highlight: { field: string; op: string; value: string; color: string }[];
  limit: number;
};

const str = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const strs = (v: unknown, n = 40) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, n) : []);
const oneOf = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt);
const num = (v: unknown) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) && n > 0 ? n : 0; };
const OPS = [...FILTER_OPS] as string[];

const TYPE_NAMES: Record<string, string> = {
  list: "List", table: "Table", board: "Board", funnel: "Funnel", calendar: "Calendar", agenda: "Agenda",
  chart: "Chart", metrics: "Overview", tracker: "Tracker", ledger: "Ledger", leaderboard: "Top",
};

export function sanitizeView(raw: any): View | null {
  if (typeof raw === "string") { const t = raw.trim(); if (!t) return null; try { raw = JSON.parse(t.replace(/^```(json)?|```$/g, "")); } catch { return null; } }
  if (Array.isArray(raw)) raw = raw[0];
  if (!raw || typeof raw !== "object") return null;
  const type = oneOf(raw.type, VIEW_TYPES, "list");
  const filter = (f: any) => ({ field: str(f?.field), op: oneOf(f?.op, OPS, "eq"), value: str(f?.value, 120) });
  return {
    name: str(raw.name, 40) || TYPE_NAMES[type],
    type,
    groupBy: str(raw.groupBy), groups: strs(raw.groups, 30),
    dateField: str(raw.dateField), measure: str(raw.measure),
    agg: oneOf(raw.agg, AGGS, raw.measure ? "sum" : "count"),
    chart: oneOf(raw.chart, ["bar", "line", "area", "pie", "donut", ""], type === "chart" ? "bar" : ""),
    bucket: oneOf(raw.bucket, ["day", "week", "month", "year", ""], ""),
    fields: strs(raw.fields, 20),
    filters: (Array.isArray(raw.filters) ? raw.filters : []).map(filter).filter((f: any) => f.field).slice(0, 12),
    sortBy: str(raw.sortBy), sortDir: oneOf(raw.sortDir, ["asc", "desc", ""], ""),
    goal: num(raw.goal), unit: str(raw.unit, 20),
    period: oneOf(raw.period, ["day", "week", "month", ""], ""),
    metrics: (Array.isArray(raw.metrics) ? raw.metrics : []).slice(0, 8).map((m: any) => ({
      label: str(m?.label, 40), agg: oneOf(m?.agg, AGGS, "count"), field: str(m?.field),
      filterField: str(m?.filterField), filterOp: oneOf(m?.filterOp, ["", ...OPS], ""), filterValue: str(m?.filterValue, 120),
    })).filter((m: any) => m.label),
    highlight: (Array.isArray(raw.highlight) ? raw.highlight : []).slice(0, 8).map((h: any) => ({
      ...filter(h), color: oneOf(h?.color, ["good", "warn", "danger", "accent"], "accent"),
    })).filter((h: any) => h.field),
    limit: Math.min(100, Math.round(num(raw.limit))),
  };
}

/** Adds a view, or replaces the one with the same name. Returns the new list. */
export function upsertView(list: unknown, view: View): View[] {
  const cur = (Array.isArray(list) ? list : []).map(sanitizeView).filter(Boolean) as View[];
  const i = cur.findIndex((v) => v.name.toLowerCase() === view.name.toLowerCase());
  if (i >= 0) cur[i] = view; else cur.push(view);
  return cur.slice(0, 16);
}

export function removeView(list: unknown, name: string): View[] {
  const cur = (Array.isArray(list) ? list : []).map(sanitizeView).filter(Boolean) as View[];
  return cur.filter((v) => v.name.toLowerCase() !== name.toLowerCase().trim());
}
