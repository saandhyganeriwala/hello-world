import { describe, expect, it } from "vitest";
import * as ops from "./operations";
import { adminSchema, validateDocument } from "./schema";

const documents = Object.entries(ops).filter(
  ([, v]) => typeof v === "string",
) as [string, string][];

describe("Admin GraphQL operations", () => {
  it("loads the pinned Admin schema", () => {
    expect(adminSchema().getQueryType()?.getFields().products).toBeTruthy();
  });

  it.each(documents)(
    "%s is valid against the Admin API schema",
    (_name, document) => {
      const result = validateDocument(document);
      expect(result.errors).toEqual([]);
    },
  );

  it("allowlisted generic mutations exist in the schema", () => {
    const fields = adminSchema().getMutationType()!.getFields();
    const missing = [...ops.GENERIC_MUTATION_ALLOWLIST].filter(
      (name) => !fields[name],
    );
    expect(missing).toEqual([]);
  });

  it("rejects invalid documents and reports root fields", () => {
    expect(validateDocument("query { shop { notAField } }").ok).toBe(false);
    const r = validateDocument("query { shop { name } }");
    expect(r).toMatchObject({
      ok: true,
      operation: "query",
      rootFields: ["shop"],
    });
  });
});
