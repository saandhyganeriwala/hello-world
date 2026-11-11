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
    { op: "create", section: "Orders", sectionIcon: "package", sectionKind: "orders", recordId: "", sectionView: "",
      fields: F({ Title: "A", Customer: "A", Product: "Pooja thalis", Quantity: "5", Rate: "₹400 each", Amount: "₹2,000", Payment: "Paid", Status: "New" }) },
    { op: "create", section: "orders", sectionIcon: "package", sectionKind: "orders", recordId: "", sectionView: "",
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
  field: "", value: "", by: "", dir: "", mode: "", accent: "", order: [], view: "", ...c });
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
  C({ type: "addView", section: "Leads", view: JSON.stringify(V({ name: "Pipeline", type: "board", groupBy: "Status", groups: ["New", "Won"], measure: "Amount", agg: "sum" })) }),
  C({ type: "addView", section: "Leads", view: JSON.stringify(V({ name: "pipeline", type: "board", groupBy: "Status", filters: [{ field: "Status", op: "neq", value: "Lost" }] })) }),
  C({ type: "addView", section: "Leads", view: JSON.stringify(V({ name: "By source", type: "chart", chart: "pie", groupBy: "Source" })) }),
]));
s = await state();
let lv = s.sections.Leads.views as any[];
check("addView adds, and replaces by name", lv.length === 2 && lv[0].filters[0]?.op === "neq" && lv[1].chart === "pie", lv);
await db.transaction((tx) => applyCommands(tx, ctx, [C({ type: "removeView", section: "Leads", name: "By source" })]));
s = await state();
check("removeView", (s.sections.Leads.views as any[]).length === 1);
// A new section can arrive with its own screen (a water tracker).
await db.transaction((tx) => applyOps(tx, ctx, [{ op: "create", section: "Water Intake", sectionIcon: "drop", sectionKind: "tracker", recordId: "",
  fields: F({ Title: "Water", Amount: "500", Unit: "ml" }), sectionView: JSON.stringify({ name: "Today", type: "tracker", measure: "Amount", unit: "ml", goal: 3000, period: "day", agg: "sum" }) }]));
s = await state();
lv = s.sections["Water Intake"].views as any[];
check("new tracker section gets its view", s.sections["Water Intake"].kind === "tracker" && s.sections["Water Intake"].icon === "drop" && lv[0]?.goal === 3000, s.sections["Water Intake"]);
check("snapshot lists saved views", (await buildSnapshot(wsId)).sections.some((x) => x.views.some((v) => v.name === "Today")));

// Billing: price a call, per-person free credit, member limits, upgrade early (carry-over), pay twice.
const { priceUsd, recordUsage, billingStatus, activatePayment, assertCanAddMember, LimitError } = await import("../src/domain/billing.js");
const { payments, members } = await import("../src/db/schema.js");
const call = { label: "understand", model: "claude-sonnet-5-5", input: 700, output: 250, cacheRead: 6300, cacheWrite: 0 };
check("prices a call from its tokens", Math.abs(priceUsd(call) - (700 * 2 + 250 * 10 + 6300 * 0.1) / 1e6) < 1e-12, priceUsd(call));
let bs = await billingStatus(wsId);
check("new workspace is free with ₹20 of AI", bs.plan === "free" && bs.limitInr === 20 && bs.ok && bs.usedInr === 0, bs);
for (let i = 0; i < 20; i++) await recordUsage(wsId, u.id, call); // 20 × ~₹0.40
const ws2 = await createWorkspace({ id: u.id, email: u.email, phone: null, name: "Asha" } as any, "Second shop");
const bs2 = await billingStatus(ws2);
check("free credit is per person, shared across their workspaces", Math.abs(bs2.usedInr - (await billingStatus(wsId)).usedInr) < 0.01 && bs2.usedInr > 7, bs2.usedInr);
const leftBefore = (await billingStatus(wsId)).leftInr;
for (let i = 0; i < 2; i++) await db.insert(members).values({ workspaceId: wsId, email: `t${i}@x.com`, name: "T" + i, color: "#000" });
let blocked = false; try { await assertCanAddMember(wsId); } catch (e) { blocked = e instanceof LimitError; }
check("free plan stops at 3 people", blocked);
await db.insert(payments).values({ workspaceId: wsId, userId: u.id, orderId: "order_test_1", amount: 99900 });
const p1 = await activatePayment("order_test_1", "pay_1"), p2 = await activatePayment("order_test_1", "pay_1");
bs = await billingStatus(wsId);
check("payment activates Pro once (idempotent)", p1.ok && !(p1 as any).already && (p2 as any).already && bs.plan === "pro", { p1, p2, plan: bs.plan });
check("upgrading early carries unused free credit into the first month", Math.abs(bs.bonusInr - leftBefore) < 0.02 && Math.abs(bs.limitInr - (450 + leftBefore)) < 0.02, { bonus: bs.bonusInr, left: leftBefore, limit: bs.limitInr });
check("…and that free credit is used up (no double counting)", !(await billingStatus(ws2)).ok);
check("Pro: fresh budget, 10 people, ~30 days", bs.ok && bs.usedInr === 0 && bs.memberLimit === 10 && Math.round((bs.planUntil! - Date.now()) / 864e5) === 30, bs);
await recordUsage(wsId, u.id, call);
check("Pro usage counts against the Pro budget, not free credit", (await billingStatus(wsId)).usedInr > 0);
await db.insert(payments).values({ workspaceId: wsId, userId: u.id, orderId: "order_test_2", amount: 99900 });
await activatePayment("order_test_2", "pay_2");
bs = await billingStatus(wsId);
check("paying again extends Pro by 30 days", Math.round((bs.planUntil! - Date.now()) / 864e5) === 60, bs.planUntil);
check("unknown order is refused", !(await activatePayment("order_nope", "x")).ok);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
