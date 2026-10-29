import { z } from "zod";
import { apiContext, json, searchParams } from "@/lib/api";
import { withUser } from "@/lib/db";
import { handler } from "@/lib/errors";

const filterSchema = z.object({
  execution_id: z.uuid().optional(),
  status: z.enum(["pending", "accepted", "completed", "dismissed"]).optional(),
});

/** Saved advisory recommendations, newest first. */
export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const f = filterSchema.parse(searchParams(req));
  const params: unknown[] = [ctx.orgId];
  const where = ["organization_id = $1"];
  if (f.execution_id) {
    params.push(f.execution_id);
    where.push(`execution_id = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  const recommendations = await withUser(ctx.user.id, (tx) =>
    tx.query(
      `select id, execution_id, key, title, rationale, actions, evidence, assumptions, risks, confidence, status, created_at, updated_at
         from public.recommendations where ${where.join(" and ")} order by created_at desc limit 100`,
      params,
    ),
  );
  return json({ recommendations });
});
