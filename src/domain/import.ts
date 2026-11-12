import type { Tx } from "../db/client.js";
import { records, type Fields } from "../db/schema.js";
import type { ImportPlanT } from "../ai/schemas.js";
import { cleanKey, esc, inferKind } from "./helpers.js";
import { ensureSection, type Ctx } from "./apply.js";

export const IMPORT_CAP = 2000;

export type Sheet = { name: string; headers: string[]; rows: Record<string, string>[] };

const TYPE_COLUMN = /^(type|record ?type|category|kind|entity|doc(ument)? ?type)$/i;
const tabName = (v: string) => {
  const t = v.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return /(s|ing)$/i.test(t) ? t : t + "s";
};

/**
 * Used when Claude isn't available: one tab per sheet, every column kept —
 * or, when a sheet has a "Type"/"Category" column with a few values, one tab per value.
 */
export function fallbackPlan(sheets: Sheet[]): ImportPlanT {
  return {
    sheets: sheets.map((s) => {
      const typeCol = s.headers.find((h) => TYPE_COLUMN.test(h.trim()));
      const values = typeCol ? [...new Set(s.rows.map((r) => (r[typeCol] ?? "").trim()).filter(Boolean))] : [];
      const cols = s.headers.filter((h) => h !== typeCol);
      const titleField = cols[0] ?? "";
      if (typeCol && values.length >= 2 && values.length <= 8) {
        return {
          sheet: s.name,
          sections: values.map((v) => ({
            name: tabName(v), kind: inferKind(v), icon: "", titleField, statusField: "",
            fields: cols.map((h) => ({ name: h, source: h })), matchColumn: typeCol, matchValues: [v],
          })),
        };
      }
      return {
        sheet: s.name,
        sections: [{
          name: s.name || "Imported", kind: inferKind(s.name || ""), icon: "", titleField: s.headers[0] ?? "",
          statusField: "", fields: s.headers.map((h) => ({ name: h, source: h })), matchColumn: "", matchValues: [],
        }],
      };
    }),
  };
}

function selectRows(rows: Sheet["rows"], column: string, values: string[]) {
  if (!column || !values?.length) return rows;
  const vals = new Set(values.map((v) => String(v).toLowerCase().trim()));
  return rows.filter((r) => r[column] != null && vals.has(String(r[column]).toLowerCase().trim()));
}

export async function applyImport(tx: Tx, ctx: Ctx, sheets: Sheet[], plan: ImportPlanT) {
  const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s]));
  const touched: string[] = [];
  const sectionNames: string[] = [];
  const newSections: string[] = [];
  let count = 0;

  for (const ps of plan.sheets ?? []) {
    const src = byName.get(String(ps.sheet ?? "").toLowerCase()) ?? (sheets.length === 1 ? sheets[0] : undefined);
    if (!src) continue;
    const secs = ps.sections?.length ? ps.sections : fallbackPlan([src]).sheets[0].sections;
    for (const sec of secs) {
      if (count >= IMPORT_CAP) break;
      const s = await ensureSection(tx, ctx.workspaceId, sec.name || src.name || "Imported", sec.icon, sec.kind);
      if (!sectionNames.includes(s.name)) sectionNames.push(s.name);
      if (s.isNew) newSections.push(s.name);
      // Claude's mapping first (clean names, sensible order), then every other column that has data under
      // its own header, so nothing in the file is silently dropped. The title, status and split columns are
      // already represented.
      const planned = (sec.fields ?? []).filter((m) => src.headers.includes(m.source));
      const used = new Set([...planned.map((m) => m.source), sec.titleField, sec.matchColumn, sec.statusField].filter(Boolean));
      const usedNames = new Set(planned.map((m) => cleanKey(m.name).toLowerCase()).concat(["title"]));
      const rest = src.headers.filter((h) => !used.has(h) && h.trim())
        .map((h) => { let name = cleanKey(h) || h; if (usedNames.has(name.toLowerCase())) name = `${name} (${h})`.slice(0, 60); usedNames.add(name.toLowerCase()); return { name, source: h }; });
      const mapping = [...planned, ...rest];

      const batch: (typeof records.$inferInsert)[] = [];
      for (const row of selectRows(src.rows, sec.matchColumn, sec.matchValues)) {
        if (count + batch.length >= IMPORT_CAP) break;
        const fields: Fields = {};
        const title = sec.titleField ? String(row[sec.titleField] ?? "").trim() : "";
        if (title) fields.Title = title;
        for (const m of mapping) {
          const v = row[m.source];
          if (v != null && String(v).trim() !== "") fields[cleanKey(m.name)] = String(v).trim();
        }
        if (sec.statusField && row[sec.statusField] && !fields.Status) fields.Status = String(row[sec.statusField]);
        if (Object.keys(fields).length <= (title ? 1 : 0)) continue;
        batch.push({
          workspaceId: ctx.workspaceId, sectionId: s.id, fields, createdBy: ctx.userId, authorName: ctx.authorName,
          history: [{ ts: Date.now(), author: ctx.authorName, type: "create", html: `<b>${esc(ctx.authorName)}</b> imported this into <b>${esc(s.name)}</b>` }],
        });
      }
      for (let i = 0; i < batch.length; i += 200) {
        const ins = await tx.insert(records).values(batch.slice(i, i + 200)).returning({ id: records.id });
        ins.forEach((r) => touched.push(r.id));
      }
      count += batch.length;
    }
  }
  return { count, sections: sectionNames, newSections, touched, capped: count >= IMPORT_CAP };
}
