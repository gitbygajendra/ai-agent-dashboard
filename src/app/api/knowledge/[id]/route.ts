import { z } from "zod";
import { apiContext, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { assertCanWrite } from "@/lib/auth/context";
import { withUser } from "@/lib/db";
import { Errors, handler } from "@/lib/errors";
import { deleteObject } from "@/lib/storage";

export const DELETE = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Document");
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const doc = await withUser(ctx.user.id, (tx) =>
    tx.one<{ storage_path: string | null }>("delete from public.knowledge_documents where id = $1 and organization_id = $2 returning storage_path", [id, ctx.orgId]),
  );
  if (!doc) throw Errors.notFound("Document");
  if (doc.storage_path) await deleteObject(doc.storage_path, ctx.orgId).catch(() => undefined);
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "knowledge.deleted", entityType: "knowledge_document", entityId: id });
  return json({ ok: true });
});
