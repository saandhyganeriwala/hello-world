import { sql } from "drizzle-orm";
import {
  boolean, doublePrecision, index, integer, json, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export type Fields = Record<string, string>;
export type HistoryEntry = { ts: number; author: string; type: "create" | "update" | "edit"; html: string };
export type SectionSort = { by: string; dir: "asc" | "desc" } | null;

// A person logs in with an email or a phone number (LOGIN_METHOD decides which).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique(),
  phone: text("phone").unique(),
  name: text("name"),
  // Free AI credit is per person (spent across all the free workspaces they own), not per workspace.
  freeSpentInr: doublePrecision("free_spent_inr").notNull().default(0),   // cost, for analytics
  freeActionsUsed: integer("free_actions_used").notNull().default(0),     // what the free limit counts
  createdAt: ts("created_at").notNull().defaultNow(),
});

// `target` is the email address or phone number the code was sent to.
export const otpCodes = pgTable("otp_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  target: text("target").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("otp_target_created_idx").on(t.target, t.createdAt)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  accent: text("accent"),
  // Shareable code for invite links (/app/join/<code>). Anyone logged in with it can join.
  inviteCode: text("invite_code").unique(),
  // Billing: "free" or "pro" until plan_until. Pro is a monthly Razorpay subscription: each charge
  // starts a new billing period (period_start → renews_at); plan_until = renews_at plus a few days' grace
  // so a late renewal webhook doesn't drop anyone to free. Fair usage resets with each period.
  plan: text("plan").notNull().default("free"),
  planUntil: ts("plan_until"),
  periodStart: ts("period_start"),
  renewsAt: ts("renews_at"),
  subscriptionId: text("subscription_id"),
  // Unused free credit carried into the first Pro period when upgrading early.
  bonusInr: doublePrecision("bonus_inr").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// A member is an email (or phone number) in a workspace. user_id is null
// until that person logs in for the first time — that's how invites work.
export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  email: text("email"),
  phone: text("phone"),
  name: text("name"),
  role: text("role").notNull().default("member"), // owner | member
  color: text("color").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("members_ws_email_uq").on(t.workspaceId, t.email),
  uniqueIndex("members_ws_phone_uq").on(t.workspaceId, t.phone),
  index("members_user_idx").on(t.userId),
  index("members_email_idx").on(t.email),
  index("members_phone_idx").on(t.phone),
]);

export const sections = pgTable("sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("tag"),
  kind: text("kind").notNull().default("generic"),
  sort: json("sort").$type<SectionSort>(),
  // Saved views (board, chart, tracker…) set by CRUD or the Customize menu. Defaults per kind live in the client.
  views: json("views").$type<Record<string, unknown>[]>(),
  position: integer("position").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("sections_ws_name_uq").on(t.workspaceId, sql`lower(${t.name})`)]);

// `json` (not jsonb) on purpose: it preserves key order, which is the order
// fields are shown in.
export const records = pgTable("records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sectionId: uuid("section_id").notNull().references(() => sections.id, { onDelete: "cascade" }),
  fields: json("fields").$type<Fields>().notNull(),
  history: json("history").$type<HistoryEntry[]>().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  authorName: text("author_name"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("records_ws_idx").on(t.workspaceId),
  index("records_section_idx").on(t.sectionId),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  role: text("role").notNull().default("user"), // user | assistant
  authorName: text("author_name"),
  text: text("text").notNull().default(""),
  images: json("images").$type<string[]>(), // small thumbnails (data URLs)
  pending: boolean("pending").notNull().default(false),
  tag: text("tag"),
  tagIcon: text("tag_icon"),
  recordId: uuid("record_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("messages_ws_created_idx").on(t.workspaceId, t.createdAt)]);

// One row per Claude call, priced in rupees from its token counts.
export const aiUsage = pgTable("ai_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  label: text("label").notNull(),                 // understand, understand+image, import-plan
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  costInr: doublePrecision("cost_inr").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("ai_usage_ws_time_idx").on(t.workspaceId, t.createdAt)]);

// Razorpay orders and what became of them. Paying is idempotent per order.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  orderId: text("order_id").notNull().unique(),
  paymentId: text("payment_id").unique(),
  subscriptionId: text("subscription_id"),
  amount: integer("amount").notNull(),            // paise
  currency: text("currency").notNull().default("INR"),
  status: text("status").notNull().default("created"), // created | paid
  createdAt: ts("created_at").notNull().defaultNow(),
  paidAt: ts("paid_at"),
});

// A Razorpay subscription (Pro, billed monthly). Created when someone starts checkout; the webhook
// and the checkout callback move it along: created → active → (cancelling) → cancelled / halted.
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  subscriptionId: text("subscription_id").notNull().unique(),
  planId: text("plan_id").notNull(),
  amount: integer("amount").notNull(),            // paise / cents per month
  currency: text("currency").notNull().default("INR"),
  status: text("status").notNull().default("created"),
  currentEnd: ts("current_end"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("subscriptions_workspace_idx").on(t.workspaceId)]);

// Razorpay plan ids, created on first use. Keyed by API key + currency + amount, so test and
// live mode, and a price change, each get their own plan.
export const razorpayPlans = pgTable("razorpay_plans", {
  key: text("key").primaryKey(),
  planId: text("plan_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
