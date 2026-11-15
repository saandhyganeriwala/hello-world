// Model lab (admin): runs realistic CRUD.chat tasks through the app's real AI code on a chosen Claude model,
// checks each answer, and records speed, tokens and cost. Runs on the server (which has the API key) and keeps
// the report in memory behind a long random id, so it can be shared as a link. Test data only — no user data.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateCustomView, modelScope, planImport, understand, type AiUsage, type Snapshot } from "../ai/claude.js";
import { priceUsd } from "./billing.js";
import { env } from "../env.js";

export const LAB_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

const snapshot: Snapshot = {
  sections: [
    { name: "Orders", kind: "orders", fields: ["Customer", "Product", "Qty", "Rate", "Amount", "Status", "Delivery", "Due"], views: [{ name: "List", type: "list" }, { name: "Board", type: "board" }] },
    { name: "Payments", kind: "payments", fields: ["From", "Amount", "Mode", "Against", "Date"], views: [{ name: "Ledger", type: "ledger" }] },
    { name: "Leads", kind: "leads", fields: ["Name", "Company", "Stage", "Value", "Phone"], views: [{ name: "List", type: "list" }] },
  ],
  records: [
    { id: "r1", section: "Orders", title: "Hotel Orchid", fields: { Customer: "Hotel Orchid", Product: "Gift hampers", Qty: "200", Rate: "600", Amount: "120000", Status: "Confirmed", Delivery: "Mumbai", Due: "20 Nov" } },
    { id: "r2", section: "Payments", title: "Hotel Orchid", fields: { From: "Hotel Orchid", Amount: "60000", Mode: "Bank transfer", Against: "Gift hampers order", Date: "31 Oct" } },
    { id: "r3", section: "Orders", title: "Ravi Traders", fields: { Customer: "Ravi Traders", Product: "Samayi", Qty: "40", Rate: "500", Amount: "20000", Status: "Delivered", Delivery: "Pune" } },
    { id: "r4", section: "Payments", title: "Ravi Traders", fields: { From: "Ravi Traders", Amount: "8000", Mode: "UPI", Against: "Samayi order", Date: "2 Nov" } },
    { id: "r5", section: "Leads", title: "Grand Hotel", fields: { Name: "Meena", Company: "Grand Hotel", Stage: "Contacted", Value: "80000" } },
    { id: "r6", section: "Leads", title: "Fresh Mart", fields: { Name: "Arjun", Company: "Fresh Mart", Stage: "New", Value: "25000" } },
    { id: "r7", section: "Leads", title: "Sunil Caterers", fields: { Name: "Sunil", Company: "Sunil Caterers", Stage: "Qualified", Value: "150000" } },
  ],
};

const fixture = (f: string) => { try { return fs.readFileSync(path.resolve(process.cwd(), "lab", f)).toString("base64"); } catch { return ""; } };
const CHAT_EXPORT = `[12/11/26, 10:02] Rohan Kirana: Bhai 20 kg basmati bhej do, 95 per kg
[12/11/26, 10:05] Thali House: Done, kal tak
[12/11/26, 11:30] Priya Caterers: Need 30 thali sets for Sunday, 350 each
[12/11/26, 11:31] Thali House: Confirmed 👍
[12/11/26, 14:10] Rohan Kirana: Payment 1900 GPay kar diya`;

// ---- checking answers ----
type U = any;
const digits = (v: unknown) => String(v ?? "").replace(/[^\d]/g, "");
const fieldsOf = (op: any): Record<string, string> => Object.fromEntries((op?.fields || []).map((f: any) => [String(f.key), String(f.value)]));
const hasVal = (op: any, re: RegExp) => Object.values(fieldsOf(op)).some((v) => re.test(v));
const hasNum = (op: any, n: number) => Object.values(fieldsOf(op)).some((v) => digits(v) === String(n));
const creates = (u: U, sec?: RegExp) => (u?.operations || []).filter((o: any) => o.op === "create" && (!sec || sec.test(o.section)));
const cmds = (u: U, type: string) => (u?.commands || []).filter((c: any) => c.type === type);
const viewOf = (c: any) => { try { return typeof c?.view === "string" ? JSON.parse(c.view) : c?.view || {}; } catch { return {}; } };

type Case = { id: string; title: string; kind: "understand" | "import" | "customview"; text?: string; images?: string[]; docs?: { name: string; mediaType: "application/pdf" | "text/plain"; data: string }[];
  viewing?: { section: string; view: unknown }; expect: string; checks: [string, (u: U) => boolean][] };

const CASES: Case[] = [
  { id: "order", title: "Typed order", kind: "understand", text: "Order from Kashish Sweets 45 Samayi at 500 each, deliver Hyderabad by Friday",
    expect: "New order: Kashish Sweets, Samayi, 45 × 500 = 22,500, Hyderabad, Friday",
    checks: [["is a record", (u) => u.kind === "record"], ["one new order", (u) => creates(u, /order/i).length === 1],
      ["customer", (u) => hasVal(creates(u)[0], /kashish/i)], ["qty 45", (u) => hasNum(creates(u)[0], 45)],
      ["amount 22,500", (u) => hasNum(creates(u)[0], 22500)], ["Hyderabad", (u) => hasVal(creates(u)[0], /hyderabad/i)],
      ["uses existing column names", (u) => Object.keys(fieldsOf(creates(u)[0])).filter((k) => k !== "Title").every((k) => snapshot.sections[0].fields.includes(k) || /due|date|note|delivery/i.test(k))]] },
  { id: "hinglish-pay", title: "Hinglish payment", kind: "understand", text: "Ravi bhai ne 12,000 UPI se bhej diya, baaki Friday tak",
    expect: "Payment from Ravi Traders, 12,000, UPI (rest due Friday)",
    checks: [["is a record", (u) => u.kind === "record"], ["in Payments", (u) => creates(u, /payment/i).length >= 1],
      ["matched to Ravi Traders", (u) => hasVal(creates(u, /payment/i)[0], /ravi traders/i)], ["12,000", (u) => hasNum(creates(u, /payment/i)[0], 12000)],
      ["UPI", (u) => hasVal(creates(u, /payment/i)[0], /upi/i)]] },
  { id: "update", title: "Update an existing order (Hinglish)", kind: "understand", text: "Hotel Orchid ka order aaj deliver ho gaya",
    expect: "Update record r1 → Status Delivered (no new record)",
    checks: [["updates r1", (u) => (u.operations || []).some((o: any) => o.op === "update" && o.recordId === "r1")],
      ["status delivered", (u) => (u.operations || []).some((o: any) => o.recordId === "r1" && hasVal(o, /deliver/i))],
      ["no new order", (u) => creates(u, /order/i).length === 0]] },
  { id: "multi", title: "Three orders in one message", kind: "understand",
    text: "Got 3 orders today: Asha 10 thali at 200 each, Vikram 5 diya sets at 450 each, Meena 2 hampers at 1500 each",
    expect: "Three new orders: 2,000 / 2,250 / 3,000",
    checks: [["three orders", (u) => creates(u, /order/i).length === 3],
      ["Asha 2,000", (u) => creates(u, /order/i).some((o: any) => hasVal(o, /asha/i) && hasNum(o, 2000))],
      ["Vikram 2,250", (u) => creates(u, /order/i).some((o: any) => hasVal(o, /vikram/i) && hasNum(o, 2250))],
      ["Meena 3,000", (u) => creates(u, /order/i).some((o: any) => hasVal(o, /meena/i) && hasNum(o, 3000))]] },
  { id: "question", title: "Question: pending amount", kind: "understand", text: "How much is pending from Hotel Orchid?",
    expect: "₹60,000 (1,20,000 − 60,000)",
    checks: [["is a question", (u) => u.kind === "question"], ["says 60,000", (u) => /60,?000/.test(u.answer || "")], ["changes nothing", (u) => !(u.operations || []).length]] },
  { id: "analysis", title: "Question: top customers", kind: "understand", text: "Who are my top 2 customers by order value?",
    expect: "Hotel Orchid (1,20,000), then Ravi Traders (20,000)",
    checks: [["is a question", (u) => u.kind === "question"],
      ["Hotel Orchid first", (u) => { const a = u.answer || ""; const i = a.search(/hotel orchid/i), j = a.search(/ravi traders/i); return i >= 0 && j > i; }]] },
  { id: "pipeline", title: "Change the app: pipeline view", kind: "understand", text: "show leads as a pipeline with totals",
    expect: "addView on Leads: board grouped by Stage, sum of Value",
    checks: [["adds a view", (u) => cmds(u, "addView").length >= 1], ["on Leads", (u) => /lead/i.test(cmds(u, "addView")[0]?.section || "")],
      ["board by Stage", (u) => { const v = viewOf(cmds(u, "addView")[0]); return v.type === "board" && /stage/i.test(v.groupBy || ""); }],
      ["totals of Value", (u) => /value/i.test(viewOf(cmds(u, "addView")[0]).measure || "")]] },
  { id: "filter", title: "Change this view: filter", kind: "understand", text: "only show orders that aren't delivered yet",
    viewing: { section: "Orders", view: { name: "List", type: "list", filters: [], groupBy: "", measure: "", agg: "count" } },
    expect: "Update the List view on Orders with a filter Status ≠ Delivered",
    checks: [["changes a view", (u) => cmds(u, "addView").length >= 1], ["on Orders", (u) => /order/i.test(cmds(u, "addView")[0]?.section || "")],
      ["filters on Status", (u) => JSON.stringify(viewOf(cmds(u, "addView")[0]).filters || []).match(/status/i) !== null],
      ["no records changed", (u) => !(u.operations || []).length]] },
  { id: "chatter", title: "Chit-chat (should do nothing)", kind: "understand", text: "ok thanks 👍",
    expect: "kind chatter, no records, no changes",
    checks: [["nothing recorded", (u) => !(u.operations || []).length], ["no app changes", (u) => !(u.commands || []).length]] },
  { id: "task", title: "Hinglish task", kind: "understand", text: "kal Meena ko demo ke liye call karna hai",
    expect: "New task: call Meena for a demo, due tomorrow",
    checks: [["one new record", (u) => creates(u).length === 1], ["a task", (u) => /task|to-?do|follow/i.test(creates(u)[0]?.section || "") || /task/i.test(creates(u)[0]?.sectionKind || "")],
      ["mentions Meena", (u) => hasVal(creates(u)[0], /meena/i)], ["due tomorrow", (u) => hasVal(creates(u)[0], /tomorrow|kal|\d/i)]] },
  { id: "screenshot", title: "WhatsApp screenshot", kind: "understand", text: "", images: ["whatsapp-order.png"],
    expect: "New order: Ananya Gifts, dry fruit boxes, 20 × 800 = 16,000, Pune, 25 Nov",
    checks: [["one new order", (u) => creates(u, /order/i).length === 1], ["Ananya Gifts", (u) => hasVal(creates(u, /order/i)[0], /ananya/i)],
      ["qty 20", (u) => hasNum(creates(u, /order/i)[0], 20)], ["16,000", (u) => hasNum(creates(u, /order/i)[0], 16000)],
      ["Pune", (u) => hasVal(creates(u, /order/i)[0], /pune/i)], ["25 Nov", (u) => hasVal(creates(u, /order/i)[0], /25/)]] },
  { id: "pdf", title: "Supplier invoice PDF", kind: "understand", text: "", docs: [{ name: "JM-2291.pdf", mediaType: "application/pdf", data: "pdf:supplier-invoice.pdf" }],
    expect: "New bill/purchase: Jaipur Metals, ₹47,600, invoice JM-2291, due 30 Nov",
    checks: [["a new record", (u) => creates(u).length >= 1], ["Jaipur Metals", (u) => creates(u).some((o: any) => hasVal(o, /jaipur metals/i))],
      ["47,600", (u) => creates(u).some((o: any) => hasNum(o, 47600))], ["invoice JM-2291", (u) => creates(u).some((o: any) => hasVal(o, /2291/))],
      ["not filed as a customer order", (u) => !creates(u).some((o: any) => /^orders?$/i.test(o.section) && hasVal(o, /jaipur/i))]] },
  { id: "chat-export", title: "WhatsApp chat export (text file)", kind: "understand", text: "", docs: [{ name: "WhatsApp Chat with customers.txt", mediaType: "text/plain", data: CHAT_EXPORT }],
    expect: "Orders: Rohan Kirana 1,900 and Priya Caterers 10,500; payment Rohan 1,900",
    checks: [["two orders", (u) => creates(u, /order/i).length === 2], ["Priya 10,500", (u) => creates(u, /order/i).some((o: any) => hasVal(o, /priya/i) && hasNum(o, 10500))],
      ["Rohan 1,900 order", (u) => creates(u, /order/i).some((o: any) => hasVal(o, /rohan/i) && hasNum(o, 1900))],
      ["Rohan's payment", (u) => creates(u, /payment/i).some((o: any) => hasVal(o, /rohan/i) && hasNum(o, 1900))]] },
  { id: "import", title: "Spreadsheet import plan", kind: "import",
    expect: "One Products/Inventory section keeping all 6 columns, titled by Product",
    checks: [["one section", (u) => (u?.sheets?.[0]?.sections || []).length === 1],
      ["keeps all 6 columns", (u) => (u?.sheets?.[0]?.sections?.[0]?.fields || []).length >= 6],
      ["titled by Product", (u) => /product/i.test(u?.sheets?.[0]?.sections?.[0]?.titleField || "")]] },
  { id: "customview", title: "Custom view code (lead funnel)", kind: "customview",
    expect: "JS drawing a 4-step funnel with counts and %, tapping opens a record",
    checks: [["wrote code", (u) => (u?.code || "").length > 300], ["uses the records", (u) => /records/.test(u?.code || "")],
      ["taps open a record", (u) => /CRUD\.open/.test(u?.code || "")], ["no network calls", (u) => !/fetch\(|XMLHttpRequest|import\(/.test(u?.code || "")]] },
];

async function runCase(c: Case, onUsage: (u: AiUsage) => void): Promise<U> {
  if (c.kind === "import") {
    return planImport({ onUsage, existing: [{ name: "Orders", kind: "orders" }], sheets: [{ sheet: "Product weights", headers: ["Product", "Variant", "Weight (g)", "Price (Rs)", "Stock", "Supplier"],
      columns: [{ header: "Product", filled: 90, of: 90, examples: ["German Silver Pooja Thali", "Brass Diya Set", "Silver Coin 10g"] }, { header: "Variant", filled: 60, of: 90, examples: ["Small", "Large"] },
        { header: "Weight (g)", filled: 90, of: 90, examples: ["250", "1200", "10"] }, { header: "Price (Rs)", filled: 90, of: 90, examples: ["1450", "3200", "950"] },
        { header: "Stock", filled: 85, of: 90, examples: ["12", "0", "40"] }, { header: "Supplier", filled: 70, of: 90, examples: ["Jaipur Metals", "Moradabad Brass"] }],
      sample: [{ Product: "German Silver Pooja Thali", Variant: "Small", "Weight (g)": "250", "Price (Rs)": "1450", Stock: "12", Supplier: "Jaipur Metals" }] }] });
  }
  if (c.kind === "customview") {
    return generateCustomView({ onUsage, section: "Leads", count: 6, spec: "Funnel: Leads → Contacted (has Contacted on) → Demo (has Demo date) → Won (Status is Won). Show each layer's count and % of the previous layer; tapping a layer opens its first record.",
      fields: [{ name: "Name", filled: 6, examples: ["Riya", "Sunil"] }, { name: "Contacted on", filled: 4, examples: ["2 Nov"] }, { name: "Demo date", filled: 3, examples: ["5 Nov"] }, { name: "Status", filled: 6, examples: ["Won", "Open", "New", "Lost"] }],
      sample: [{ Name: "Riya", "Contacted on": "2 Nov", "Demo date": "5 Nov", Status: "Won" }, { Name: "Sunil", "Contacted on": "3 Nov", Status: "Open" }, { Name: "Vikram", Status: "New" }] });
  }
  const docs = (c.docs || []).map((d) => ({ ...d, data: d.data.startsWith("pdf:") ? fixture(d.data.slice(4)) : d.data }));
  const images = (c.images || []).map((f) => ({ data: fixture(f), mediaType: "image/png" as const }));
  return understand({ onUsage, text: c.text || "", snapshot, images, docs, viewing: c.viewing ?? null });
}

// ---- runs (kept in memory; a redeploy clears them) ----
type Row = { case: string; title: string; model: string; run: number; ms: number; passed: number; total: number; checks: { name: string; pass: boolean }[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }; inr: number; expect: string; output: unknown; error?: string };
type Lab = { id: string; status: "running" | "done" | "error"; started: number; finished?: number; models: string[]; runs: number; total: number; done: number; rows: Row[] };
const labs = new Map<string, Lab>();

export function startLab(models: string[], runs: number) {
  const id = crypto.randomBytes(18).toString("base64url");
  const lab: Lab = { id, status: "running", started: Date.now(), models, runs, total: models.length * runs * CASES.length, done: 0, rows: [] };
  labs.set(id, lab);
  for (const [k, v] of labs) if (Date.now() - v.started > 7 * 864e5) labs.delete(k);
  (async () => {
    for (const model of models) for (let run = 1; run <= runs; run++) for (const c of CASES) {
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }; let usd = 0;
      const t0 = Date.now(); let out: U = null, error: string | undefined;
      try {
        out = await modelScope.run(model, () => runCase(c, (u) => {
          usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite; usage.calls++; usd += priceUsd(u);
        }));
        if (!out) error = "No valid answer (refused or unreadable)";
      } catch (e: any) { error = String(e?.message || e).slice(0, 300); }
      const checks = c.checks.map(([name, fn]) => { let pass = false; try { pass = !!out && !!fn(out); } catch { pass = false; } return { name, pass }; });
      lab.rows.push({ case: c.id, title: c.title, model, run, ms: Date.now() - t0, passed: checks.filter((x) => x.pass).length, total: checks.length, checks,
        usage, inr: Math.round(usd * env.usdInr * 1000) / 1000, expect: c.expect, output: out, error });
      lab.done++;
    }
    lab.status = "done"; lab.finished = Date.now();
  })().catch((e) => { lab.status = "error"; console.error("[lab]", e); });
  return lab;
}

export function labReport(id: string) {
  const lab = labs.get(id);
  if (!lab) return null;
  const summary = lab.models.map((model) => {
    const rows = lab.rows.filter((r) => r.model === model);
    const checks = rows.reduce((n, r) => n + r.total, 0), passed = rows.reduce((n, r) => n + r.passed, 0);
    return { model, cases: rows.length, casesFullyRight: rows.filter((r) => r.passed === r.total).length, checks, checksPassed: passed,
      avgMs: rows.length ? Math.round(rows.reduce((n, r) => n + r.ms, 0) / rows.length) : 0,
      totalInr: Math.round(rows.reduce((n, r) => n + r.inr, 0) * 100) / 100,
      avgInr: rows.length ? Math.round((rows.reduce((n, r) => n + r.inr, 0) / rows.length) * 1000) / 1000 : 0,
      errors: rows.filter((r) => r.error).length };
  });
  return { ...lab, summary };
}
