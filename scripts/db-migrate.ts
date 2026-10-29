/**
 * Applies SQL migrations to the database in DATABASE_URL.
 *
 *   npm run db:migrate            # Supabase or any Postgres that already has the auth schema
 *   npm run db:migrate -- --local # plain local Postgres: installs the Supabase compat shim first
 *
 * For a hosted Supabase project you can use `supabase db push` instead; both
 * apply the same files in supabase/migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const local = process.argv.includes("--local");
  const root = path.resolve(__dirname, "..", "supabase");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (local) {
      const shim = await readFile(path.join(root, "local", "000_supabase_compat.sql"), "utf8");
      await client.query(shim);
      console.log("applied local Supabase compatibility shim");
    }

    await client.query(`
      create table if not exists public._app_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query("revoke all on public._app_migrations from public");

    const dir = path.join(root, "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("select name from public._app_migrations");
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into public._app_migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // The tracking table must never be reachable by API roles.
    await client.query("revoke all on public._app_migrations from authenticated, anon");
    console.log("migrations up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
