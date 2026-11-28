import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildSchema,
  getVariableValues,
  parse,
  validate,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql";

// ------------------------------------------------------------------ Schema validation

let schema: GraphQLSchema | null = null;

/** The Admin API schema for the pinned version (2026-10), shipped gzipped in the repo. */
export function adminSchema(): GraphQLSchema {
  if (!schema) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "admin-2026-10.graphql.gz"),
      join(process.cwd(), "app/agent/shopify/admin-2026-10.graphql.gz"),
    ];
    const file = candidates.find((path) => {
      try {
        readFileSync(path, { flag: "r" });
        return true;
      } catch {
        return false;
      }
    });
    if (!file) throw new Error("Admin GraphQL schema file not found");
    schema = buildSchema(gunzipSync(readFileSync(file)).toString("utf8"), {
      assumeValidSDL: true,
    });
  }
  return schema;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  operation?: "query" | "mutation" | "subscription";
  rootFields: string[];
}

/** Validates a GraphQL document against the Admin schema and reports its operation type and root fields. */
export function validateDocument(document: string): ValidationResult {
  let ast;
  try {
    ast = parse(document);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message], rootFields: [] };
  }
  const operations = ast.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  if (operations.length !== 1)
    return {
      ok: false,
      errors: ["Send exactly one operation."],
      rootFields: [],
    };
  const errors = validate(adminSchema(), ast).map((e) => e.message);
  const op = operations[0];
  const rootFields = op.selectionSet.selections.flatMap((s) =>
    s.kind === "Field" ? [s.name.value] : [],
  );
  return {
    ok: errors.length === 0,
    errors,
    operation: op.operation,
    rootFields,
  };
}

/** Validates a document and its variable values (types, required fields, enum values) against the schema. */
export function validateOperation(
  document: string,
  variables: Record<string, unknown> = {},
): string[] {
  const doc = validateDocument(document);
  if (!doc.ok) return doc.errors;
  const ast = parse(document);
  const op = ast.definitions.find(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  )!;
  const result = getVariableValues(
    adminSchema(),
    op.variableDefinitions ?? [],
    variables,
  );
  return result.errors ? result.errors.map((e) => e.message) : [];
}
