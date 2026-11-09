// Structured-output schemas. Claude's reply is constrained to these shapes,
// so we never parse free text. Structured outputs need fixed object shapes,
// which is why record fields are a list of {key, value} pairs rather than a map,
// and optional values are nullable.
import { z } from "zod/v4"; // the SDK's structured-output helper is built on zod v4
import { KINDS } from "../domain/helpers.js";

const Kind = z.enum(KINDS);
const Field = z.object({ key: z.string(), value: z.string() });

export const Operation = z.object({
  op: z.enum(["create", "update", "delete"]),
  section: z.string(),
  sectionIcon: z.string(),
  sectionKind: Kind,
  recordId: z.string().nullable(),
  fields: z.array(Field),
});

export const COMMAND_TYPES = [
  "renameSection", "createSection", "deleteSection", "clearSection", "mergeSections", "reorderSections",
  "setSectionKind", "setSectionIcon", "addField", "renameField", "removeField", "setSort", "setTheme", "renameWorkspace",
] as const;

export const Command = z.object({
  type: z.enum(COMMAND_TYPES),
  section: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  into: z.string().nullable(),
  name: z.string().nullable(),
  kind: Kind.nullable(),
  icon: z.string().nullable(),
  field: z.string().nullable(),
  value: z.string().nullable(),
  by: z.string().nullable(),
  dir: z.enum(["asc", "desc"]).nullable(),
  mode: z.enum(["light", "dark", "system"]).nullable(),
  accent: z.string().nullable(),
  order: z.array(z.string()).nullable(),
});

export const Understanding = z.object({
  kind: z.enum(["record", "question", "command", "chatter"]),
  operations: z.array(Operation),
  commands: z.array(Command),
  answer: z.string(),
  focus: z.string(),
});

export const ImportPlan = z.object({
  sheets: z.array(z.object({
    sheet: z.string(),
    sections: z.array(z.object({
      name: z.string(),
      kind: Kind,
      icon: z.string(),
      titleField: z.string(),
      statusField: z.string(),
      fields: z.array(z.object({ name: z.string(), source: z.string() })),
      match: z.object({ column: z.string(), values: z.array(z.string()) }).nullable(),
    })),
  })),
});

export type OperationT = z.infer<typeof Operation>;
export type CommandT = z.infer<typeof Command>;
export type UnderstandingT = z.infer<typeof Understanding>;
export type ImportPlanT = z.infer<typeof ImportPlan>;
