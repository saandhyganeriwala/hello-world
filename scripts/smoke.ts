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

// Billing: price a call, 10 free actions per person, member limits, upgrade early (carry-over), pay twice.
const { priceUsd, recordUsage, billingStatus, applyCharge, setSubscriptionStatus, addMonth, assertCanAddMember, LimitError } = await import("../src/domain/billing.js");
const { payments, members, subscriptions } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const call = { label: "understand", model: "claude-sonnet-5-5", input: 700, output: 250, cacheRead: 6300, cacheWrite: 0 };
check("prices a call from its tokens", Math.abs(priceUsd(call) - (700 * 2 + 250 * 10 + 6300 * 0.1) / 1e6) < 1e-12, priceUsd(call));
let bs = await billingStatus(wsId);
check("new workspace is free with 10 AI actions", bs.plan === "free" && bs.actionsLimit === 10 && bs.actionsLeft === 10 && bs.ok, bs);
for (let i = 0; i < 6; i++) await recordUsage(wsId, u.id, call);
await recordUsage(wsId, u.id, { ...call, label: "transcribe" }, 0.001);
bs = await billingStatus(wsId);
check("each AI call is one action; transcription isn't", bs.actionsUsed === 6 && bs.actionsLeft === 4, { used: bs.actionsUsed, left: bs.actionsLeft });
const ws2 = await createWorkspace({ id: u.id, email: u.email, phone: null, name: "Asha" } as any, "Second shop");
check("free actions are per person, shared across their workspaces", (await billingStatus(ws2)).actionsLeft === 4);
for (let i = 0; i < 2; i++) await db.insert(members).values({ workspaceId: wsId, email: `t${i}@x.com`, name: "T" + i, color: "#000" });
let blocked = false; try { await assertCanAddMember(wsId); } catch (e) { blocked = e instanceof LimitError; }
check("free plan stops at 3 people", blocked);
await db.insert(subscriptions).values({ workspaceId: wsId, userId: u.id, subscriptionId: "sub_test_1", planId: "plan_x", amount: 49900 });
const DAYMS = 864e5, t0 = new Date(), t1 = addMonth(t0);
const p1 = await applyCharge({ subscriptionId: "sub_test_1", paymentId: "pay_1" });
const p2 = await applyCharge({ subscriptionId: "sub_test_1", paymentId: "pay_1", periodStart: t0, periodEnd: t1 }); // webhook after checkout
bs = await billingStatus(wsId);
check("first charge activates Pro once (idempotent)", p1.ok && !(p1 as any).already && (p2 as any).already && bs.plan === "pro", { p1, p2, plan: bs.plan });
check("upgrading early carries the 4 unused free actions into the first month", bs.bonusActions === 4 && bs.actionsLimit === 500 + 4, { bonus: bs.bonusActions, limit: bs.actionsLimit });
check("…and those free actions are used up (no double counting)", !(await billingStatus(ws2)).ok);
check("Pro: 500 actions, 10 people, renews in a month (+3 days' grace)", bs.ok && bs.actionsUsed === 0 && bs.memberLimit === 10
  && bs.renewsAt === t1.getTime() && bs.planUntil === t1.getTime() + 3 * DAYMS && bs.subscription?.status === "active", bs);
check("addMonth keeps month ends sane", addMonth(new Date("2027-01-31T10:00:00Z")).toISOString().startsWith("2027-02-28") && addMonth(new Date("2027-03-15T00:00:00Z")).toISOString().startsWith("2027-04-15"));
for (let i = 0; i < 5; i++) await recordUsage(wsId, u.id, call);
const after = await billingStatus(wsId);
check("Pro usage comes out of the Pro allowance", after.actionsLeft < bs.actionsLeft && after.usedInr > 0, { before: bs.actionsLeft, after: after.actionsLeft });
// Renewal: Razorpay charges again for the next month.
const t2 = addMonth(t1);
await applyCharge({ subscriptionId: "sub_test_1", paymentId: "pay_2", periodStart: new Date(), periodEnd: t2 });
bs = await billingStatus(wsId);
check("renewal starts a fresh month: usage resets, carry-over ends, renews later", bs.renewsAt === t2.getTime() && bs.actionsUsed === 0 && bs.bonusActions === 0 && bs.actionsLimit === 500, bs);
check("two payments recorded", (await db.select().from(payments).where(eq(payments.subscriptionId, "sub_test_1"))).length === 2);
// Retry in progress: still Pro. Cancel: Pro until the paid period ends, no renewal shown.
await setSubscriptionStatus("sub_test_1", "pending");
check("failed renewal being retried keeps Pro", (await billingStatus(wsId)).plan === "pro");
await setSubscriptionStatus("sub_test_1", "cancelling");
await setSubscriptionStatus("sub_test_1", "active"); // a stray status event mustn't undo the cancellation
bs = await billingStatus(wsId);
check("cancelling keeps Pro to the end of the period, stops showing a renewal", bs.plan === "pro" && bs.subscription?.status === "cancelling" && bs.renewsAt === null && bs.periodEnds === t2.getTime(), bs);
await setSubscriptionStatus("sub_test_1", "cancelled");
bs = await billingStatus(wsId);
check("cancelled: Pro until the paid date, grace removed", bs.plan === "pro" && bs.planUntil === t2.getTime(), bs.planUntil);
await setSubscriptionStatus("sub_test_1", "halted");
check("halted: back to free", (await billingStatus(wsId)).plan === "free");
check("unknown subscription is refused", !(await applyCharge({ subscriptionId: "sub_nope", paymentId: "x" })).ok);


// Import keeps every column with data, even ones the plan leaves out.
{
  const { applyImport } = await import("../src/domain/import.js");
  const wsI = await createWorkspace({ id: u.id, email: u.email, phone: null, name: "Asha" } as any, "Import test");
  const headers = ["Order ID", "Customer", "Product", "Qty", "Amount", "Order Status", "GSTIN", "Notes", "Sales Rep"];
  const rows = Array.from({ length: 30 }, (_, i) => ({ "Order ID": "SO-" + i, Customer: "Cust " + i, Product: "Box", Qty: String(i + 1), Amount: String(100 * (i + 1)),
    "Order Status": i % 2 ? "Paid" : "New", ...(i > 24 ? { GSTIN: "27ABCDE1234F1Z" + i } : {}), ...(i === 29 ? { Notes: "rush" } : {}), "Sales Rep": "Pranav" }));
  const plan = { sheets: [{ sheet: "Orders", sections: [{ name: "Orders", kind: "orders", icon: "package", titleField: "Customer", statusField: "Order Status",
    fields: [{ name: "Product", source: "Product" }, { name: "Amount", source: "Amount" }], matchColumn: "", matchValues: [] }] }] } as any;
  const out = await db.transaction((tx) => applyImport(tx, { workspaceId: wsI, userId: u.id, authorName: "Asha" }, [{ name: "Orders", headers, rows }], plan));
  const st = await loadState(wsI, u.id);
  const recsI = st.records.filter((r: any) => r.section === "Orders");
  const keys = new Set(recsI.flatMap((r: any) => Object.keys(r.fields)));
  check("import brings in all 30 rows", out.count === 30 && recsI.length === 30, out);
  check("import keeps columns the plan left out (ids, sparse GSTIN, one-off Notes, rep)", ["Title", "Product", "Amount", "Status", "Order ID", "Qty", "GSTIN", "Notes", "Sales Rep"].every((k) => keys.has(k)), [...keys]);
  check("status column isn't duplicated", !keys.has("Order Status"), [...keys]);
}


// Account deletion: shared workspaces are handed over, solo ones deleted, no ghost invites left behind.
{
  const { deleteAccount } = await import("../src/domain/account.js");
  const { users: U, members: M, workspaces: W } = await import("../src/db/schema.js");
  const { eq: EQ, and: AND } = await import("drizzle-orm");
  const [a] = await db.insert(U).values({ email: "leaver@example.com", name: "Leaver" }).returning();
  const [bUser] = await db.insert(U).values({ email: "stayer@example.com", name: "Stayer" }).returning();
  const shared = await createWorkspace({ id: a.id, email: a.email, phone: null, name: "Leaver" } as any, "Shared shop");
  const solo = await createWorkspace({ id: a.id, email: a.email, phone: null, name: "Leaver" } as any, "Solo shop");
  await db.insert(M).values({ workspaceId: shared, userId: bUser.id, email: bUser.email, name: "Stayer", color: "#000" });
  const del = await deleteAccount(a.id);
  const [sw] = await db.select().from(W).where(EQ(W.id, shared));
  const [so] = await db.select().from(W).where(EQ(W.id, solo));
  const ghost = await db.select().from(M).where(EQ(M.email, "leaver@example.com"));
  const [stayerRow] = await db.select().from(M).where(AND(EQ(M.workspaceId, shared), EQ(M.userId, bUser.id)));
  check("delete account: shared workspace handed to the teammate", sw?.createdBy === bUser.id && stayerRow?.role === "owner" && del.handedOver.includes("Shared shop"), del);
  check("delete account: solo workspace deleted", !so && del.deletedWorkspaces.includes("Solo shop"));
  check("delete account: user and their memberships gone (no ghost invite)", ghost.length === 0 && !(await db.select().from(U).where(EQ(U.id, a.id))).length);
}


// One person, several Pro workspaces at once (two Razorpay, one App Store): each is billed and limited on its own.
{
  const { subscriptions: SUB, users: U2 } = await import("../src/db/schema.js");
  const { applyAppleTransaction } = await import("../src/domain/iap.js");
  const [owner] = await db.insert(U2).values({ email: "multi@example.com", name: "Multi" }).returning();
  const mk = (n: string) => createWorkspace({ id: owner.id, email: owner.email, phone: null, name: "Multi" } as any, n);
  const [wa, wb, wc] = [await mk("Shop A"), await mk("Shop B"), await mk("Shop C")];
  const end = addMonth(new Date());
  await db.insert(SUB).values([
    { workspaceId: wa, userId: owner.id, subscriptionId: "sub_multi_a", planId: "plan_x", amount: 49900 },
    { workspaceId: wb, userId: owner.id, subscriptionId: "sub_multi_b", planId: "plan_x", amount: 49900 },
  ]);
  await applyCharge({ subscriptionId: "sub_multi_a", paymentId: "pay_multi_a1", periodEnd: end });
  await applyCharge({ subscriptionId: "sub_multi_b", paymentId: "pay_multi_b1", periodEnd: end });
  await applyAppleTransaction({ originalTransactionId: "77", transactionId: "771", productId: "chat.crud.pro.monthly", bundleId: "chat.crud.app",
    purchaseDate: Date.now(), expiresDate: end.getTime(), appAccountToken: wc } as any, owner.id, wc);
  const [ba, bb, bc] = [await billingStatus(wa), await billingStatus(wb), await billingStatus(wc)];
  check("several Pro workspaces for one person, each with its own subscription", ba.plan === "pro" && bb.plan === "pro" && bc.plan === "pro"
    && ba.subscription?.provider === "razorpay" && bc.subscription?.provider === "apple", [ba.plan, bb.plan, bc.plan]);
  check("each Pro workspace gets its own 10 people and allowance", [ba, bb, bc].every((x) => x.memberLimit === 10 && x.actionsLimit >= 500));
  await setSubscriptionStatus("sub_multi_a", "halted");
  check("a failed payment on one workspace leaves the others Pro", (await billingStatus(wa)).plan === "free" && (await billingStatus(wb)).plan === "pro" && (await billingStatus(wc)).plan === "pro");
  await applyCharge({ subscriptionId: "sub_multi_b", paymentId: "pay_multi_b2", periodEnd: addMonth(end) });
  check("renewing one doesn't move the others' dates", (await billingStatus(wb)).renewsAt === addMonth(end).getTime() && (await billingStatus(wc)).renewsAt === end.getTime());
  let msg = ""; try { for (let i = 0; i < 3; i++) await db.insert(members).values({ workspaceId: wa, email: `ma${i}@x.com`, name: "M", color: "#000" }); await assertCanAddMember(wa); } catch (e: any) { msg = e.message; }
  check("free workspace limit message says to upgrade this workspace", /Upgrade this workspace to Pro/.test(msg), msg);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
