import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { getDb } from "../db/client.js";
import { records, sections, workspaces, type Fields, type HistoryEntry } from "../db/schema.js";
import type { CommandT } from "../ai/schemas.js";
import type { Snapshot } from "../ai/claude.js";
import { cleanKey, esc, inferKind, normKind, recTitle, resolveColor, sectionIcon } from "./helpers.js";

export type Ctx = { workspaceId: string; userId: string; authorName: string; contextRecordId?: string | null; messageText?: string };

// Operations come from Claude ({key,value}[] fields) or the local fallback parser (plain object).
export type LooseOp = {
  op?: string; action?: string; section?: string; sectionIcon?: string; sectionKind?: string;
  recordId?: string | null; status?: string;
  fields?: { key: string; value: string }[] | Record<string, unknown>;
};

const SNAPSHOT_RECORDS = 150;

function toFields(f: LooseOp["fields"]): Fields {
  const out: Fields = {};
  const put = (k: unknown, v: unknown) => {
    const val = v == null ? "" : String(v).trim();
    if (val) out[cleanKey(k)] = val;
  };
  if (Array.isArray(f)) f.forEach((x) => put(x?.key, x?.value));
  else if (f && typeof f === "object") Object.entries(f).forEach(([k, v]) => put(k, v));
  return out;
}

const history = (author: string, type: HistoryEntry["type"], html: string): HistoryEntry => ({ ts: Date.now(), author, type, html });

export async function ensureSection(tx: Tx, workspaceId: string, rawName: string, icon?: unknown, kind?: unknown) {
  const name = (rawName || "").trim() || "Notes";
  const find = async () => (await tx.select().from(sections)
    .where(and(eq(sections.workspaceId, workspaceId), sql`lower(${sections.name}) = lower(${name})`)).limit(1))[0];
  const existing = await find();
  if (existing) return { id: existing.id, name: existing.name, isNew: false };
  const [{ pos }] = await tx.select({ pos: sql<number>`coalesce(max(${sections.position}), -1)::int` })
    .from(sections).where(eq(sections.workspaceId, workspaceId));
  const [ins] = await tx.insert(sections).values({
    workspaceId, name, icon: sectionIcon(name, icon), kind: normKind(kind) || inferKind(name), position: pos + 1,
  }).onConflictDoNothing().returning();
  if (ins) return { id: ins.id, name: ins.name, isNew: true };
  const raced = await find(); // someone created it at the same moment
  return { id: raced!.id, name: raced!.name, isNew: false };
}

export async function findSection(tx: Tx, workspaceId: string, name: unknown) {
  const n = String(name ?? "").toLowerCase().trim();
  if (!n) return null;
  const all = await tx.select().from(sections).where(eq(sections.workspaceId, workspaceId));
  return all.find((s) => s.name.toLowerCase() === n) ?? all.find((s) => s.name.toLowerCase().includes(n)) ?? null;
}

/** Applies record operations (create/update/delete). Returns what to show in the chat tag. */
export async function applyOps(tx: Tx, ctx: Ctx, ops: LooseOp[]) {
  const secRows = await tx.select({ id: sections.id, name: sections.name, icon: sections.icon }).from(sections)
    .where(eq(sections.workspaceId, ctx.workspaceId));
  const secName = new Map(secRows.map((s) => [s.id, s.name]));
  const recs = await tx.select({ id: records.id, sectionId: records.sectionId, fields: records.fields, history: records.history })
    .from(records).where(eq(records.workspaceId, ctx.workspaceId));

  const findRecord = (id: unknown, hint: Fields) => {
    if (id) { const r = recs.find((x) => x.id === id); if (r) return r; }
    const h = (hint.Title || hint.Customer || hint.Name || "").toLowerCase();
    if (!h) return null;
    return recs.find((r) => {
      const t = recTitle(secName.get(r.sectionId) ?? "", r.fields).toLowerCase();
      return t && (t.includes(h) || h.includes(t));
    }) ?? null;
  };

  const touched: string[] = [];
  let created = 0, updated = 0, deleted = 0, lastSection: string | null = null, lastRid: string | null = null, isNew = false;

  for (const op of ops) {
    let kind = String(op.op || op.action || "create").toLowerCase();
    const opFields = toFields(op.fields);
    if (op.status && !opFields.Status) opFields.Status = String(op.status);
    if (["none", "query", "read"].includes(kind)) continue;

    if (kind === "delete") {
      const r = findRecord(op.recordId, opFields);
      if (r) {
        await tx.delete(records).where(eq(records.id, r.id));
        recs.splice(recs.indexOf(r), 1);
        deleted++; lastSection = secName.get(r.sectionId) ?? lastSection;
      }
      continue;
    }

    if (kind === "update") {
      const r = findRecord(op.recordId, opFields) ?? (ctx.contextRecordId ? recs.find((x) => x.id === ctx.contextRecordId) : null);
      if (r) {
        const fields = { ...r.fields };
        const changed: string[] = [];
        for (const [k, v] of Object.entries(opFields)) {
          if (k === "Title" && fields.Title && Object.keys(opFields).length > 1) continue; // keep the title stable
          if (fields[k] !== v) changed.push(k);
          fields[k] = v;
        }
        const hist = [...(r.history ?? []), history(ctx.authorName, "update",
          `<b>${esc(ctx.authorName)}</b> ${changed.length ? "updated " + changed.map(esc).join(", ") : "noted an update"}`)];
        await tx.update(records).set({ fields, history: hist, updatedAt: new Date() }).where(eq(records.id, r.id));
        r.fields = fields; r.history = hist;
        updated++; lastSection = secName.get(r.sectionId) ?? lastSection; lastRid = r.id; touched.push(r.id);
        continue;
      }
      kind = "create"; // nothing matched — record it as new
    }

    const sec = await ensureSection(tx, ctx.workspaceId, op.section || "Notes", op.sectionIcon, op.sectionKind);
    secName.set(sec.id, sec.name);
    isNew = isNew || sec.isNew;
    const fields = Object.keys(opFields).length ? opFields : { Note: ctx.messageText || "" };
    const [rec] = await tx.insert(records).values({
      workspaceId: ctx.workspaceId, sectionId: sec.id, fields, createdBy: ctx.userId, authorName: ctx.authorName,
      history: [history(ctx.authorName, "create", `<b>${esc(ctx.authorName)}</b> added this to <b>${esc(sec.name)}</b>`)],
    }).returning({ id: records.id, sectionId: records.sectionId, fields: records.fields, history: records.history });
    recs.push(rec);
    created++; lastSection = sec.name; lastRid = rec.id; touched.push(rec.id);
  }

  const icon = secRows.find((s) => s.name === lastSection)?.icon;
  let tag: string, tagIcon = "checkc";
  if (created && !updated && !deleted) { tag = (created > 1 ? `${created} added to ` : "Added to ") + lastSection; tagIcon = icon || sectionIcon(lastSection || ""); }
  else if (updated && !created && !deleted) { tag = `Updated in ${lastSection}`; tagIcon = "wand"; }
  else if (deleted && !created && !updated) { tag = `Deleted from ${lastSection}`; tagIcon = "trash"; }
  else if (created || updated || deleted) tag = `Updated ${lastSection}`;
  else tag = "Noted";
  return { tag, tagIcon, section: lastSection, isNew, rid: lastRid, touched, changed: created + updated + deleted };
}

export type Effect = { type: "theme"; mode: "light" | "dark" | "system" };

/** Applies interface commands (sections, fields, sorting, look). */
export async function applyCommands(tx: Tx, ctx: Ctx, cmds: CommandT[] | any[]) {
  const ws = ctx.workspaceId;
  const summary: string[] = [];
  const effects: Effect[] = [];
  let goto: string | null = null;

  const sectionRecords = (sectionId: string) =>
    tx.select({ id: records.id, fields: records.fields }).from(records).where(eq(records.sectionId, sectionId));
  const saveFields = (id: string, fields: Fields) => tx.update(records).set({ fields }).where(eq(records.id, id));

  for (const c of cmds ?? []) {
    const type = String(c?.type ?? "").toLowerCase().replace(/[_\s]/g, "");
    try {
      if (type === "renamesection") {
        const s = await findSection(tx, ws, c.from || c.section), to = String(c.to || c.name || "").trim();
        if (s && to && !(await findSectionExact(tx, ws, to))) {
          await tx.update(sections).set({ name: to }).where(eq(sections.id, s.id));
          goto = to; summary.push(`renamed “${s.name}” to “${to}”`);
        }
      } else if (type === "createsection") {
        const name = String(c.name || c.section || c.to || "").trim();
        if (name) { const s = await ensureSection(tx, ws, name, c.icon, c.kind); goto = s.name; summary.push(`created “${s.name}”`); }
      } else if (type === "deletesection") {
        const s = await findSection(tx, ws, c.section || c.from);
        if (s) { await tx.delete(sections).where(eq(sections.id, s.id)); summary.push(`deleted “${s.name}”`); }
      } else if (type === "clearsection") {
        const s = await findSection(tx, ws, c.section || c.from);
        if (s) { await tx.delete(records).where(eq(records.sectionId, s.id)); goto = s.name; summary.push(`cleared “${s.name}”`); }
      } else if (type === "mergesections") {
        const from = await findSection(tx, ws, c.from || c.section), into = await findSection(tx, ws, c.into || c.to);
        if (from && into && from.id !== into.id) {
          await tx.update(records).set({ sectionId: into.id }).where(eq(records.sectionId, from.id));
          await tx.delete(sections).where(eq(sections.id, from.id));
          goto = into.name; summary.push(`merged “${from.name}” into “${into.name}”`);
        }
      } else if (type === "reordersections") {
        const order: string[] = Array.isArray(c.order) ? c.order : [];
        let pos = 0; const seen = new Set<string>();
        for (const n of order) {
          const s = await findSection(tx, ws, n);
          if (s && !seen.has(s.id)) { seen.add(s.id); await tx.update(sections).set({ position: pos++ }).where(eq(sections.id, s.id)); }
        }
        const rest = await tx.select().from(sections).where(eq(sections.workspaceId, ws));
        for (const s of rest.filter((s) => !seen.has(s.id)).sort((a, b) => a.position - b.position)) {
          await tx.update(sections).set({ position: pos++ }).where(eq(sections.id, s.id));
        }
        if (seen.size) summary.push("reordered sections");
      } else if (type === "setsectionkind") {
        const s = await findSection(tx, ws, c.section || c.from), k = normKind(c.kind || c.to);
        if (s && k) { await tx.update(sections).set({ kind: k }).where(eq(sections.id, s.id)); goto = s.name; summary.push(`“${s.name}” now shows as ${k}`); }
      } else if (type === "setsectionicon") {
        const s = await findSection(tx, ws, c.section || c.from);
        if (s) { await tx.update(sections).set({ icon: sectionIcon(s.name, c.icon) }).where(eq(sections.id, s.id)); goto = s.name; summary.push(`changed “${s.name}” icon`); }
      } else if (type === "addfield") {
        const s = await findSection(tx, ws, c.section), f = cleanKey(c.field || c.name), val = c.value != null ? String(c.value) : "";
        if (s && f) {
          for (const r of await sectionRecords(s.id)) if (r.fields[f] == null) await saveFields(r.id, { ...r.fields, [f]: val });
          goto = s.name; summary.push(`added field “${f}”`);
        }
      } else if (type === "renamefield") {
        const s = await findSection(tx, ws, c.section), from = String(c.from || c.field || ""), to = cleanKey(c.to);
        if (s && from && to) {
          for (const r of await sectionRecords(s.id)) {
            if (r.fields[from] == null) continue;
            const next: Fields = {};
            for (const [k, v] of Object.entries(r.fields)) next[k === from ? to : k] = v; // keeps field order
            await saveFields(r.id, next);
          }
          goto = s.name; summary.push(`renamed field “${from}” → “${to}”`);
        }
      } else if (type === "removefield") {
        const s = await findSection(tx, ws, c.section), f = String(c.field || c.from || "");
        if (s && f) {
          for (const r of await sectionRecords(s.id)) {
            if (r.fields[f] == null) continue;
            const next = { ...r.fields }; delete next[f]; await saveFields(r.id, next);
          }
          goto = s.name; summary.push(`removed field “${f}”`);
        }
      } else if (type === "setsort") {
        const s = await findSection(tx, ws, c.section || c.from), by = c.by || c.field;
        if (s) {
          const dir = /asc|low|oldest|a-z/i.test(String(c.dir || "")) ? "asc" : "desc";
          await tx.update(sections).set({ sort: by ? { by: String(by), dir } : null }).where(eq(sections.id, s.id));
          goto = s.name; summary.push(`sorted “${s.name}”${by ? " by " + by : ""}`);
        }
      } else if (type === "settheme") {
        const mode = String(c.mode || "").toLowerCase();
        if (mode === "light" || mode === "dark" || mode === "system") effects.push({ type: "theme", mode });
        const raw = String(c.accent || "").toLowerCase();
        if (/reset|default|none/.test(raw)) await tx.update(workspaces).set({ accent: null }).where(eq(workspaces.id, ws));
        else { const ac = resolveColor(c.accent); if (ac) await tx.update(workspaces).set({ accent: ac }).where(eq(workspaces.id, ws)); }
        summary.push("updated the look");
      } else if (type === "renameworkspace") {
        const to = String(c.to || c.name || "").trim();
        if (to) { await tx.update(workspaces).set({ name: to }).where(eq(workspaces.id, ws)); summary.push(`renamed the workspace to “${to}”`); }
      }
    } catch (e) {
      console.error("[commands] failed", type, e);
    }
  }
  return { summary, goto, effects };
}

async function findSectionExact(tx: Tx, workspaceId: string, name: string) {
  return (await tx.select().from(sections)
    .where(and(eq(sections.workspaceId, workspaceId), sql`lower(${sections.name}) = lower(${name})`)).limit(1))[0] ?? null;
}

/** What Claude sees about the workspace: sections with their field names, and recent records. */
export async function buildSnapshot(workspaceId: string): Promise<Snapshot> {
  const db = getDb();
  const secs = await db.select().from(sections).where(eq(sections.workspaceId, workspaceId)).orderBy(sections.position);
  const recs = await db.select().from(records).where(eq(records.workspaceId, workspaceId))
    .orderBy(desc(records.updatedAt)).limit(SNAPSHOT_RECORDS);
  const secName = new Map(secs.map((s) => [s.id, s.name]));
  const vocab = new Map<string, Set<string>>();
  for (const r of recs) {
    const n = secName.get(r.sectionId) ?? "";
    const set = vocab.get(n) ?? new Set();
    Object.keys(r.fields).forEach((k) => set.size < 14 && set.add(k));
    vocab.set(n, set);
  }
  return {
    sections: secs.map((s) => ({ name: s.name, kind: s.kind, fields: [...(vocab.get(s.name) ?? [])] })),
    records: recs.map((r) => {
      const section = secName.get(r.sectionId) ?? "";
      return {
        id: r.id, section, title: recTitle(section, r.fields),
        fields: Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, String(v).slice(0, 60)])),
      };
    }),
  };
}
