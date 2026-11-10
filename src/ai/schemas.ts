// Structured-output schemas. Claude's reply is constrained to these shapes,
// so we never parse free text.
//
// The API caps strict schemas at 16 union-typed parameters and 24 optional ones
// across the whole request. So nothing here is nullable or optional: "not set" is
// an empty string, an empty list, or 0, and "maybe one" is a list of zero or one.
// Record fields are a list of {key, value} pairs because objects need fixed keys.
import { z } from "zod/v4"; // the SDK's structured-output helper is built on zod v4
import { ICONS, KINDS } from "../domain/helpers.js";

const Kind = z.enum(KINDS);
const KindOrNone = z.enum([...KINDS, ""]);
const Field = z.object({ key: z.string(), value: z.string() });

// ---------- views: how a section is shown ----------

export const VIEW_TYPES = [
  "list", "table", "board", "funnel", "calendar", "agenda", "chart", "metrics", "tracker", "ledger", "leaderboard",
] as const;
export const FILTER_OPS = [
  "eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "notEmpty", "today", "thisWeek", "thisMonth", "lastDays",
] as const;
export const AGGS = ["count", "sum", "avg", "min", "max"] as const;

const Filter = z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.string() });
const Metric = z.object({
  label: z.string(), agg: z.enum(AGGS), field: z.string(),
  filterField: z.string(), filterOp: z.enum([...FILTER_OPS, ""]), filterValue: z.string(),
});
const Highlight = z.object({
  field: z.string(), op: z.enum(FILTER_OPS), value: z.string(), color: z.enum(["good", "warn", "danger", "accent"]),
});

export const View = z.object({
  name: z.string(),
  type: z.enum(VIEW_TYPES),
  groupBy: z.string(),                 // board columns, list groups, chart categories, leaderboard rows
  groups: z.array(z.string()),         // fixed order of columns / stages
  dateField: z.string(),               // calendar, agenda, tracker, time charts; "" = when it was recorded
  measure: z.string(),                 // field to add up; "" = count records
  agg: z.enum(AGGS),
  chart: z.enum(["bar", "line", "area", "pie", "donut", ""]),
  bucket: z.enum(["day", "week", "month", "year", ""]),
  fields: z.array(z.string()),         // fields/columns to show, in order
  filters: z.array(Filter),
  sortBy: z.string(),
  sortDir: z.enum(["asc", "desc", ""]),
  goal: z.number(),                    // tracker / metric target; 0 = none
  unit: z.string(),
  period: z.enum(["day", "week", "month", ""]),
  metrics: z.array(Metric),
  highlight: z.array(Highlight),
  limit: z.number(),                   // leaderboard top N; 0 = all
});

// ---------- what Claude returns for a message ----------

export const Operation = z.object({
  op: z.enum(["create", "update", "delete"]),
  section: z.string(),
  sectionIcon: z.string(),
  sectionKind: Kind,
  recordId: z.string(),                // "" for a create
  fields: z.array(Field),
  sectionView: z.array(View),          // only when this creates a new section that deserves a custom screen
});

export const COMMAND_TYPES = [
  "renameSection", "createSection", "deleteSection", "clearSection", "mergeSections", "reorderSections",
  "setSectionKind", "setSectionIcon", "addField", "renameField", "removeField", "setSort", "setTheme", "renameWorkspace",
  "addView", "removeView",
] as const;

export const Command = z.object({
  type: z.enum(COMMAND_TYPES),
  section: z.string(),
  from: z.string(),
  to: z.string(),
  into: z.string(),
  name: z.string(),
  kind: KindOrNone,
  icon: z.string(),
  field: z.string(),
  value: z.string(),
  by: z.string(),
  dir: z.enum(["asc", "desc", ""]),
  mode: z.enum(["light", "dark", "system", ""]),
  accent: z.string(),
  order: z.array(z.string()),
  view: z.array(View),                 // addView: exactly one
});

export const Understanding = z.object({
  kind: z.enum(["record", "question", "command", "chatter"]),
  operations: z.array(Operation),
  commands: z.array(Command),
  answer: z.string(),
  focus: z.string(),
});

export const ImportPlan = z.object({
  sheets: z.array(z.object({
    sheet: z.string(),
    sections: z.array(z.object({
      name: z.string(),
      kind: Kind,
      icon: z.string(),
      titleField: z.string(),
      statusField: z.string(),
      fields: z.array(z.object({ name: z.string(), source: z.string() })),
      matchColumn: z.string(),         // "" when the whole sheet is one kind
      matchValues: z.array(z.string()),
    })),
  })),
});

export const ICON_LIST = ICONS;
export type ViewT = z.infer<typeof View>;
export type OperationT = z.infer<typeof Operation>;
export type CommandT = z.infer<typeof Command>;
export type UnderstandingT = z.infer<typeof Understanding>;
export type ImportPlanT = z.infer<typeof ImportPlan>;
