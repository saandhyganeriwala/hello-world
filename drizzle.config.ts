import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./drizzle from the schema.
// Migrations are applied automatically when the server boots.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
