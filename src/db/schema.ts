import { sql } from "drizzle-orm";
import {
  boolean, index, integer, json, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export type Fields = Record<string, string>;
export type HistoryEntry = { ts: number; author: string; type: "create" | "update" | "edit"; html: string };
export type SectionSort = { by: string; dir: "asc" | "desc" } | null;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const otpCodes = pgTable("otp_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("otp_phone_created_idx").on(t.phone, t.createdAt)]);

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
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// A member is a phone number in a workspace. user_id is null until that
// person logs in for the first time (that's how invites work).
export const members = pgTable("members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  phone: text("phone").notNull(),
  name: text("name"),
  role: text("role").notNull().default("member"), // owner | member
  color: text("color").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("members_ws_phone_uq").on(t.workspaceId, t.phone),
  index("members_user_idx").on(t.userId),
  index("members_phone_idx").on(t.phone),
]);

export const sections = pgTable("sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("tag"),
  kind: text("kind").notNull().default("generic"),
  sort: json("sort").$type<SectionSort>(),
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
