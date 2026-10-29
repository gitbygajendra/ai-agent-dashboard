import { z } from "zod";
import { apiContext, json } from "@/lib/api";
import { assertCanWrite } from "@/lib/auth/context";
import { readJson } from "@/lib/agents/handlers/shared";
import { withUser } from "@/lib/db";
import { Errors, handler } from "@/lib/errors";

const schema = z.object({ status: z.enum(["pending", "accepted", "completed", "dismissed"]) });

export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Recommendation");
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const { status } = schema.parse(await readJson(req));
  const row = await withUser(ctx.user.id, (tx) =>
    tx.one("update public.recommendations set status = $3 where id = $1 and organization_id = $2 returning id, status", [id, ctx.orgId, status]),
  );
  if (!row) throw Errors.notFound("Recommendation");
  return json({ recommendation: row });
});
