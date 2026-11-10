// Smoke test for the record + command engine, using Claude-shaped output.
// Runs against a throwaway embedded Postgres; no API key needed.
//   npm run smoke
import fs from "node:fs";
process.env.PGLITE_DIR = ".data/smoke";
delete process.env.DATABASE_URL;
fs.rmSync(".data/smoke", { recursive: true, force: true });

const { initDb, getDb } = await import("../src/db/client.js");
const { applyOps, applyCommands, buildSnapshot } = await import("../src/domain/apply.js");
const { createWorkspace, loadState } = await import("../src/domain/state.js");
const { users } = await import("../src/db/schema.js");
const { Command, Understanding } = await import("../src/ai/schemas.js");

await initDb();
const db = getDb();
const [u] = await db.insert(users).values({ phone: "+919999999999", name: "Tester" }).returning();
const wsId = await createWorkspace({ id: u.id, email: u.email, phone: u.phone, name: u.name }, "Smoke");
const ctx = { workspaceId: wsId, userId: u.id, authorName: "Tester" };

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  → " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};
const state = async () => (await loadState(wsId, u.id))!;
const F = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

// A reply exactly as Claude returns it — validated through the real schema first.
const reply = Understanding.parse({
  kind: "record", answer: "", focus: "", commands: [],
  operations: [
    { op: "create", section: "Orders", sectionIcon: "package", sectionKind: "orders", recordId: "", sectionView: [],
      fields: F({ Title: "A", Customer: "A", Product: "Pooja thalis", Quantity: "5", Rate: "₹400 each", Amount: "₹2,000", Payment: "Paid", Status: "New" }) },
    { op: "create", section: "orders", sectionIcon: "package", sectionKind: "orders", recordId: "", sectionView: [],
      fields: F({ Title: "Kashish", Customer: "Kashish", Amount: "₹22,500", Status: "New" }) },
  ],
});
const r1 = await db.transaction((tx) => applyOps(tx, ctx, reply.operations));
let s = await state();
check("creates records in one section (case-insensitive reuse)", s.order.length === 1 && s.records.length === 2, s.order);
check("keeps field order", Object.keys(s.records.find((r) => r.fields.Customer === "A")!.fields)[0] === "Title");
check("chat tag", r1.tag === "2 added to Orders", r1.tag);

const kash = s.records.find((r) => r.fields.Customer === "Kashish")!;
await db.transaction((tx) => applyOps(tx, ctx, [{ op: "update", section: "Orders", sectionIcon: "", sectionKind: "orders", recordId: kash.id, fields: F({ Status: "Dispatched" }) }]));
s = await state();
check("update by recordId", s.records.find((r) => r.id === kash.id)!.fields.Status === "Dispatched");

const snap = await buildSnapshot(wsId);
check("snapshot lists sections with field names", snap.sections[0].fields.includes("Amount") && snap.records.length === 2, snap.sections);

// Commands exactly as Claude returns them: every property present, unused ones empty.
const C = (c: Record<string, unknown>) => Command.parse({ section: "", from: "", to: "", into: "", name: "", kind: "", icon: "",
  field: "", value: "", by: "", dir: "", mode: "", accent: "", order: [], view: [], ...c });
const V = (v: Record<string, unknown>) => ({ name: "", type: "list", groupBy: "", groups: [], dateField: "", measure: "", agg: "count",
  chart: "", bucket: "", fields: [], filters: [], sortBy: "", sortDir: "", goal: 0, unit: "", period: "", metrics: [], highlight: [], limit: 0, ...v });
const out = await db.transaction((tx) => applyCommands(tx, ctx, [
  C({ type: "renameSection", from: "Orders", to: "Sales" }),
  C({ type: "addField", section: "Sales", field: "GST", value: "18%" }),
  C({ type: "renameField", section: "Sales", from: "Amount", to: "Total" }),
  C({ type: "removeField", section: "Sales", field: "Payment" }),
  C({ type: "setSort", section: "Sales", by: "Total", dir: "desc" }),
  C({ type: "createSection", name: "Leads", kind: "inquiries", icon: "chat" }),
  C({ type: "createSection", name: "Prospects", kind: "inquiries" }),
  C({ type: "mergeSections", from: "Prospects", into: "Leads" }),
  C({ type: "setSectionKind", section: "Leads", kind: "crm" }),
  C({ type: "setSectionIcon", section: "Leads", icon: "people" }),
  C({ type: "reorderSections", order: ["Leads", "Sales"] }),
  C({ type: "setTheme", mode: "dark", accent: "green" }),
  C({ type: "renameWorkspace", to: "Thali House" }),
]));
s = await state();
const sale = s.records.find((r) => r.fields.Customer === "A")!;
check("renameSection", s.order.includes("Sales") && !s.order.includes("Orders"), s.order);
check("addField", sale.fields.GST === "18%", sale.fields);
check("renameField keeps order", sale.fields.Total === "₹2,000" && Object.keys(sale.fields).indexOf("Total") === 5, Object.keys(sale.fields));
check("removeField", sale.fields.Payment === undefined);
check("setSort", s.sections.Sales.sort?.by === "Total" && s.sections.Sales.sort?.dir === "desc", s.sections.Sales.sort);
check("create + merge sections", s.order.includes("Leads") && !s.order.includes("Prospects"), s.order);
check("setSectionKind + icon", s.sections.Leads.kind === "crm" && s.sections.Leads.icon === "people", s.sections.Leads);
check("reorderSections", s.order[0] === "Leads", s.order);
check("setTheme accent (shared) + mode (personal effect)", s.accent === "#1C8A57" && out.effects[0]?.mode === "dark", { accent: s.accent, effects: out.effects });
check("renameWorkspace", s.name === "Thali House");

await db.transaction((tx) => applyCommands(tx, ctx, [C({ type: "clearSection", section: "Sales" })]));
s = await state();
check("clearSection keeps the tab, removes records", s.order.includes("Sales") && !s.records.some((r) => r.section === "Sales"));
await db.transaction((tx) => applyCommands(tx, ctx, [C({ type: "deleteSection", section: "Sales" })]));
s = await state();
check("deleteSection", !s.order.includes("Sales"), s.order);

// Views: add a board, replace it with a filtered one, add a chart, remove it.
await db.transaction((tx) => applyCommands(tx, ctx, [
  C({ type: "addView", section: "Leads", view: [V({ name: "Pipeline", type: "board", groupBy: "Status", groups: ["New", "Won"], measure: "Amount", agg: "sum" })] }),
  C({ type: "addView", section: "Leads", view: [V({ name: "pipeline", type: "board", groupBy: "Status", filters: [{ field: "Status", op: "neq", value: "Lost" }] })] }),
  C({ type: "addView", section: "Leads", view: [V({ name: "By source", type: "chart", chart: "pie", groupBy: "Source" })] }),
]));
s = await state();
let lv = s.sections.Leads.views as any[];
check("addView adds, and replaces by name", lv.length === 2 && lv[0].filters[0]?.op === "neq" && lv[1].chart === "pie", lv);
await db.transaction((tx) => applyCommands(tx, ctx, [C({ type: "removeView", section: "Leads", name: "By source" })]));
s = await state();
check("removeView", (s.sections.Leads.views as any[]).length === 1);
// A new section can arrive with its own screen (a water tracker).
await db.transaction((tx) => applyOps(tx, ctx, [{ op: "create", section: "Water Intake", sectionIcon: "drop", sectionKind: "tracker", recordId: "",
  fields: F({ Title: "Water", Amount: "500", Unit: "ml" }), sectionView: [V({ name: "Today", type: "tracker", measure: "Amount", unit: "ml", goal: 3000, period: "day", agg: "sum" })] }]));
s = await state();
lv = s.sections["Water Intake"].views as any[];
check("new tracker section gets its view", s.sections["Water Intake"].kind === "tracker" && s.sections["Water Intake"].icon === "drop" && lv[0]?.goal === 3000, s.sections["Water Intake"]);
check("snapshot lists saved views", (await buildSnapshot(wsId)).sections.some((x) => x.views.some((v) => v.name === "Today")));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
