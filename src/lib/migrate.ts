/**
 * Applies supabase/migrations/*.sql in order, tracked in public._app_migrations.
 * Used by `npm run db:migrate` (Postgres) and by the embedded database on first use.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Exec = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export async function applyMigrations(exec: Exec, opts: { supabaseDir: string; local: boolean; log?: (msg: string) => void }) {
  const log = opts.log ?? (() => {});
  if (opts.local) {
    // Plain Postgres has no Supabase auth schema/roles: install the compat shim (idempotent).
    await exec(await readFile(path.join(opts.supabaseDir, "local", "000_supabase_compat.sql"), "utf8"));
    log("applied local Supabase compatibility shim");
  }
  await exec(`
    create table if not exists public._app_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  await exec("revoke all on public._app_migrations from public");

  const dir = path.join(opts.supabaseDir, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await exec("select name from public._app_migrations");
  const applied = new Set(rows.map((r) => String(r.name)));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await exec("begin");
    try {
      await exec(sql);
      await exec("insert into public._app_migrations (name) values ($1)", [file]);
      await exec("commit");
      log(`applied ${file}`);
    } catch (err) {
      await exec("rollback");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  // The tracking table must never be reachable by API roles.
  await exec("revoke all on public._app_migrations from authenticated, anon");
  log("migrations up to date");
}
