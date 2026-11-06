import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

/**
 * Driver-agnostic handle. Both the postgres-js and PGlite drizzle drivers satisfy this, so repo
 * functions accept either (and a transaction handle, which is a PgDatabase too).
 */
export type Db = PgDatabase<any, typeof schema>;

export interface CreateDbOptions {
  /** Postgres connection string. Falls back to env DATABASE_URL. */
  url?: string;
  /** PGlite data directory. Falls back to env PGLITE_DIR, then <repo root>/.pglite. */
  pgliteDir?: string;
  /** In-memory PGlite (tests). Takes precedence over url and pgliteDir. */
  memory?: boolean;
}

export const DEFAULT_PGLITE_DIR = fileURLToPath(new URL("../../../.pglite", import.meta.url));

/**
 * Opens a database. Selection order: memory flag, then url / DATABASE_URL (postgres-js),
 * then PGlite persisted at pgliteDir / PGLITE_DIR / .pglite.
 * Call migrate(db) before use. Call closeDb(db) when finished.
 */
export function createDb(opts: CreateDbOptions = {}): Db {
  if (opts.memory) {
    return drizzlePglite(new PGlite(), { schema }) as unknown as Db;
  }
  const url = opts.url || process.env.DATABASE_URL;
  if (url) {
    // Idempotent migrations emit "already exists, skipping" notices on every startup; drop them.
    // Pooled endpoints (Neon "-pooler", PgBouncer transaction mode) don't support prepared statements.
    const pooled = url.includes("-pooler") || process.env.DB_POOLED === "true";
    const max = Number(process.env.DB_POOL_MAX ?? 10);
    return drizzlePostgres(postgres(url, { max, prepare: !pooled, onnotice: () => undefined }), { schema }) as unknown as Db;
  }
  const dir = opts.pgliteDir || process.env.PGLITE_DIR || DEFAULT_PGLITE_DIR;
  return drizzlePglite(new PGlite(dir), { schema }) as unknown as Db;
}

/** Closes the underlying connection or PGlite instance. */
export async function closeDb(db: Db): Promise<void> {
  const client: unknown = (db as unknown as { $client?: unknown }).$client;
  if (client instanceof PGlite) {
    await client.close();
  } else if (client && typeof (client as postgres.Sql).end === "function") {
    await (client as postgres.Sql).end();
  }
}

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

/** Splits schema.sql into single statements (comments stripped). */
export function migrationStatements(source: string = SCHEMA_SQL): string[] {
  return source
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Creates all tables and indexes from schema.sql. Idempotent: safe to run on every startup.
 * Runs in one transaction, one statement at a time (works for both drivers).
 */
export async function migrate(db: Db): Promise<void> {
  const statements = migrationStatements();
  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  });
}
