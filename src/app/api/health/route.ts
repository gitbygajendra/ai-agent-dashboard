import { pingDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Reports no configuration details. */
export async function GET() {
  const db = await pingDatabase();
  return Response.json({ ok: db, database: db ? "up" : "down" }, { status: db ? 200 : 503, headers: { "cache-control": "no-store" } });
}
