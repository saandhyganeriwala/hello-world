// Dev check: prints the JSON schemas sent to Claude and flags anything structured outputs rejects.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Understanding, ImportPlan } from "../src/ai/schemas.js";
const unions: string[] = [];
function walk(node: any, path: string, issues: string[]) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" || node.properties) {
    if (node.additionalProperties !== false) issues.push(`${path}: additionalProperties=${JSON.stringify(node.additionalProperties)}`);
    const req = new Set(node.required ?? []);
    for (const k of Object.keys(node.properties ?? {})) if (!req.has(k)) issues.push(`${path}.${k}: not required`);
  }
  for (const bad of ["minimum","maximum","minLength","maxLength","pattern","patternProperties"]) if (bad in node) issues.push(`${path}: has ${bad}`);
  if (node.anyOf || Array.isArray(node.type)) unions.push(path);
  for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") walk(v, `${path}/${k}`, issues);
}
for (const [name, s] of [["Understanding", Understanding], ["ImportPlan", ImportPlan]] as const) {
  const fmt: any = betaZodOutputFormat(s as any);
  const issues: string[] = []; walk(fmt.schema, name, issues);
  console.log(`${name}: type=${fmt.type}, ${JSON.stringify(fmt.schema).length} bytes, issues: ${issues.length ? "\n  " + issues.join("\n  ") : "none"}`);
  console.log(`  union-typed params (API limit 16 per request): ${unions.length}${unions.length ? " → " + unions.join(", ") : ""}`); unions.length = 0;
}
// round-trip a realistic response through the parser
const sample = { kind: "record", operations: [{ op: "create", section: "Orders", sectionIcon: "package", sectionKind: "orders", recordId: "", sectionView: [],
  fields: [{ key: "Title", value: "A" }, { key: "Amount", value: "₹2,000" }] }], commands: [], answer: "", focus: "" };
const view = { name: "Pipeline", type: "board", groupBy: "Status", groups: ["New","Won"], dateField: "", measure: "Amount", agg: "sum", chart: "", bucket: "", fields: [], filters: [{ field: "Status", op: "neq", value: "Lost" }], sortBy: "", sortDir: "", goal: 0, unit: "", period: "", metrics: [], highlight: [], limit: 0 };
const cmd = { kind: "command", operations: [], commands: [{ type: "addView", section: "Leads", from: "", to: "", into: "", name: "", kind: "", icon: "", field: "", value: "", by: "", dir: "", mode: "", accent: "", order: [], view: [view] }], answer: "Done", focus: "Leads" };
console.log("parse addView sample:", Understanding.safeParse(cmd).success);
console.log("parse sample:", Understanding.safeParse(sample).success);
