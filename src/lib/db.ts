import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { Pool, type QueryResultRow } from "pg";
import { env } from "./env";
import { applyMigrations } from "./migrate";

/**
 * Database access.
 *
 * All user-facing queries run inside `withUser`, which switches the
 * transaction to the `authenticated` role and sets the same JWT claims
 * Supabase sets for PostgREST. Row Level Security therefore applies to every
 * query exactly as it would through the Supabase API.
 *
 * `withService` runs as `service_role` (bypasses RLS). Use it only for
 * server-owned writes after the caller has been authorized in code:
 * execution status from n8n callbacks, integration status, audit logs.
 *
 * With Supabase, point DATABASE_URL at the transaction pooler (port 6543).
 * `set local` is transaction-scoped, so it is safe with transaction pooling.
 *
 * Without DATABASE_URL the app uses PGlite: real Postgres compiled to
 * WebAssembly, running inside this process with its data in .data/db. Same
 * SQL, same RLS policies; migrations are applied on first use.
 */
const globalForPool = globalThis as unknown as { __agentDashPool?: Pool; __agentDashPglite?: Promise<PGlite> };

function embedded(): Promise<PGlite> {
  globalForPool.__agentDashPglite ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
    const dataDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), ".data", "db");
    await mkdir(dataDir, { recursive: true });
    const db = await PGlite.create({ dataDir, extensions: { pgcrypto } });
    const fresh = !(await db.query<{ t: string | null }>("select to_regclass('public._app_migrations')::text as t")).rows[0]?.t;
    await applyMigrations((sql, params) => (params?.length ? db.query(sql, params) : db.exec(sql).then((r) => r[r.length - 1] ?? { rows: [] })) as never, {
      supabaseDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), "supabase"),
      local: fresh,
    });
    return db;
  })().catch((err) => {
    globalForPool.__agentDashPglite = undefined;
    throw err;
  });
  return globalForPool.__agentDashPglite;
}

function pool(): Pool {
  if (!globalForPool.__agentDashPool) {
    const e = env();
    globalForPool.__agentDashPool = new Pool({
      connectionString: e.DATABASE_URL,
      ssl: e.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return globalForPool.__agentDashPool;
}

export type Tx = {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R | null>;
};

type Queryable = { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> };

function wrap(client: Queryable): Tx {
  // A transaction is one connection: queue queries so callers can still use
  // Promise.all without overlapping client.query() calls.
  let queue: Promise<unknown> = Promise.resolve();
  function run<R extends QueryResultRow>(sql: string, params?: unknown[]) {
    const next = queue.then(() => client.query<R>(sql, params as unknown[]));
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    async query<R extends QueryResultRow>(sql: string, params?: unknown[]) {
      return (await run<R>(sql, params)).rows;
    },
    async one<R extends QueryResultRow>(sql: string, params?: unknown[]) {
      return ((await run<R>(sql, params)).rows[0] as R | undefined) ?? null;
    },
  };
}

async function inTransaction<T>(setup: (c: Queryable) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!env().DATABASE_URL) {
    // PGlite runs one transaction at a time; its transaction() queues the rest.
    const db = await embedded();
    return db.transaction(async (t) => {
      await setup(t as unknown as Queryable);
      return fn(wrap(t as unknown as Queryable));
    });
  }
  const client = await pool().connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async (c) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await c.query("set local role authenticated");
  }, fn);
}

export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async (c) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await c.query("set local role service_role");
  }, fn);
}

/** Lightweight connectivity check for the health endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    if (!env().DATABASE_URL) await (await embedded()).query("select 1");
    else await pool().query("select 1");
    return true;
  } catch {
    return false;
  }
}
