// Dev check: prints the JSON schemas sent to Claude and flags anything structured outputs rejects.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Understanding, ImportPlan } from "../src/ai/schemas.js";
function walk(node: any, path: string, issues: string[]) {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" || node.properties) {
    if (node.additionalProperties !== false) issues.push(`${path}: additionalProperties=${JSON.stringify(node.additionalProperties)}`);
    const req = new Set(node.required ?? []);
    for (const k of Object.keys(node.properties ?? {})) if (!req.has(k)) issues.push(`${path}.${k}: not required`);
  }
  for (const bad of ["minimum","maximum","minLength","maxLength","pattern","patternProperties"]) if (bad in node) issues.push(`${path}: has ${bad}`);
  for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") walk(v, `${path}/${k}`, issues);
}
for (const [name, s] of [["Understanding", Understanding], ["ImportPlan", ImportPlan]] as const) {
  const fmt: any = betaZodOutputFormat(s as any);
  const issues: string[] = []; walk(fmt.schema, name, issues);
  console.log(`${name}: type=${fmt.type}, ${JSON.stringify(fmt.schema).length} bytes, issues: ${issues.length ? "\n  " + issues.join("\n  ") : "none"}`);
}
// round-trip a realistic response through the parser
const sample = { kind: "record", operations: [{ op: "create", section: "Orders", sectionIcon: "package", sectionKind: "orders", recordId: null,
  fields: [{ key: "Title", value: "A" }, { key: "Amount", value: "₹2,000" }] }], commands: [], answer: "", focus: "" };
console.log("parse sample:", Understanding.safeParse(sample).success);
