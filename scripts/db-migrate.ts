/**
 * Applies SQL migrations to the database in DATABASE_URL.
 *
 *   npm run db:migrate            # Supabase or any Postgres that already has the auth schema
 *   npm run db:migrate -- --local # plain local Postgres: installs the Supabase compat shim first
 *
 * For a hosted Supabase project you can use `supabase db push` instead; both
 * apply the same files in supabase/migrations.
 */
import path from "node:path";
import { Client } from "pg";
import { applyMigrations } from "../src/lib/migrate";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (without it the app uses its embedded database and migrates itself).");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyMigrations((sql, params) => client.query(sql, params as unknown[]), {
      supabaseDir: path.resolve(__dirname, "..", "supabase"),
      local: process.argv.includes("--local"),
      log: (m) => console.log(m),
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
