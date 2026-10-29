import { z } from "zod";
import { apiContext, json, searchParams } from "@/lib/api";
import { assertCanWrite } from "@/lib/auth/context";
import { readJson } from "@/lib/agents/handlers/shared";
import { withUser } from "@/lib/db";
import { Errors, handler } from "@/lib/errors";

const filterSchema = z.object({
  id: z.uuid().optional(),
  status: z.enum(["open", "resolved", "escalated", "closed"]).optional(),
});

/** Support conversations (the ticket queue). With ?id=, returns one conversation including messages. */
export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const f = filterSchema.parse(searchParams(req));
  return withUser(ctx.user.id, async (tx) => {
    if (f.id) {
      const conversation = await tx.one(
        `select id, customer_name, customer_email, channel, status, topic, urgency, messages, ticket_ref, escalated_at, created_at, updated_at
           from public.support_conversations where id = $1 and organization_id = $2`,
        [f.id, ctx.orgId],
      );
      if (!conversation) throw Errors.notFound("Conversation");
      return json({ conversation });
    }
    const params: unknown[] = [ctx.orgId];
    let where = "organization_id = $1";
    if (f.status) {
      params.push(f.status);
      where += " and status = $2";
    }
    const conversations = await tx.query(
      `select id, customer_name, customer_email, status, topic, urgency, ticket_ref, escalated_at, created_at, updated_at,
              jsonb_array_length(messages) as message_count,
              messages -> (jsonb_array_length(messages) - 1) ->> 'content' as last_message
         from public.support_conversations where ${where} order by updated_at desc limit 100`,
      params,
    );
    return json({ conversations });
  });
});

const patchSchema = z.object({ id: z.uuid(), status: z.enum(["open", "resolved", "escalated", "closed"]) });

/** Update a conversation's status (e.g. a person resolves an escalated ticket). */
export const PATCH = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const { id, status } = patchSchema.parse(await readJson(req));
  const row = await withUser(ctx.user.id, (tx) =>
    tx.one("update public.support_conversations set status = $3 where id = $1 and organization_id = $2 returning id, status", [id, ctx.orgId, status]),
  );
  if (!row) throw Errors.notFound("Conversation");
  return json({ conversation: row });
});
