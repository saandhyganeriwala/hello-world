import fs from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "../env.js";
import * as schema from "./schema.js";

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
// The transaction object exposes the same query API as the database.
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

let db: DB | null = null;
const migrationsFolder = path.resolve(process.cwd(), "drizzle");

/** Connects (Postgres in production, embedded PGlite locally) and applies migrations. */
export async function initDb(): Promise<DB> {
  if (db) return db;
  if (env.databaseUrl) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // prepare:false keeps it compatible with connection poolers (Supabase, Neon).
    // onnotice: silence Postgres NOTICEs (e.g. "already exists, skipping" on every boot's migration check).
    const sqlClient = postgres(env.databaseUrl, { max: 10, prepare: false, onnotice: () => {} });
    const d = drizzle(sqlClient, { schema });
    await migrate(d, { migrationsFolder });
    db = d as unknown as DB;
    console.log("[db] connected to Postgres");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    fs.mkdirSync(env.pgliteDir, { recursive: true });
    const client = new PGlite(env.pgliteDir);
    const d = drizzle(client, { schema });
    await migrate(d, { migrationsFolder });
    db = d as unknown as DB;
    console.log(`[db] using embedded Postgres at ${env.pgliteDir}`);
  }
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("Database not initialised — call initDb() first");
  return db;
}
