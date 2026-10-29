import "server-only";
import { z } from "zod";
import { audit } from "../../audit";
import { assertCanWrite, type OrgContext } from "../../auth/context";
import { withUser, type Tx } from "../../db";
import { Errors } from "../../errors";
import { searchKnowledge } from "../../knowledge";
import type { SupportInput, SupportResult } from "../logic/support";
import type { AgentHandler } from "../types";
import { readJson } from "./shared";

const bodySchema = z.object({
  conversation_id: z.uuid().nullish(),
  message: z.string().trim().min(1, "Type a message.").max(4000),
  customer_name: z.string().trim().max(200).nullish(),
  customer_email: z.email().max(320).nullish(),
});

type Message = { role: "customer" | "assistant"; content: string; at: string; citations?: unknown; execution_id?: string; escalated?: boolean };
type Conversation = { id: string; customer_name: string | null; customer_email: string | null; messages: Message[] };

async function buildInput(tx: Tx, ctx: OrgContext, convo: Conversation, message: string): Promise<SupportInput> {
  const knowledge = await searchKnowledge(tx, ctx.orgId, message);
  const orderSystem = await tx.one<{ status: string }>(
    "select status from public.integrations where organization_id = $1 and provider = 'order_system'",
    [ctx.orgId],
  );
  const history = convo.messages.slice(0, -1).slice(-8).map((m) => ({ role: m.role, content: m.content }));
  return {
    message,
    history,
    customer: { name: convo.customer_name, email: convo.customer_email },
    knowledge,
    integrations: { order_system: orderSystem?.status === "connected" },
    company_name: ctx.orgName,
  };
}

export const supportHandler: AgentHandler = {
  async prepare(ctx, req) {
    assertCanWrite(ctx);
    const body = bodySchema.parse(await readJson(req));
    const emailInMessage = body.message.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
    return withUser(ctx.user.id, async (tx) => {
      let convo: Conversation | null;
      const msg: Message = { role: "customer", content: body.message, at: new Date().toISOString() };
      if (body.conversation_id) {
        convo = await tx.one<Conversation>(
          `update public.support_conversations
              set messages = messages || $3::jsonb,
                  customer_name = coalesce(customer_name, $4),
                  customer_email = coalesce(customer_email, $5),
                  status = case when status = 'resolved' then 'open' else status end
            where id = $1 and organization_id = $2
            returning id, customer_name, customer_email, messages`,
          [body.conversation_id, ctx.orgId, JSON.stringify([msg]), body.customer_name ?? null, body.customer_email ?? emailInMessage],
        );
        if (!convo) throw Errors.notFound("Conversation");
      } else {
        convo = await tx.one<Conversation>(
          `insert into public.support_conversations (organization_id, customer_name, customer_email, messages, created_by)
           values ($1, $2, $3, $4, auth.uid())
           returning id, customer_name, customer_email, messages`,
          [ctx.orgId, body.customer_name ?? null, body.customer_email ?? emailInMessage, JSON.stringify([msg])],
        );
      }
      const input = await buildInput(tx, ctx, convo!, body.message);
      return {
        input,
        inputSummary: { conversation_id: convo!.id, message: body.message.slice(0, 200), knowledge_matches: input.knowledge.length },
        inputRef: { conversation_id: convo!.id, message: body.message },
      };
    });
  },
  async rebuild(ctx, execution) {
    const ref = execution.input_ref as { conversation_id: string; message: string };
    return withUser(ctx.user.id, async (tx) => {
      const convo = await tx.one<Conversation>(
        "select id, customer_name, customer_email, messages from public.support_conversations where id = $1 and organization_id = $2",
        [ref.conversation_id, ctx.orgId],
      );
      if (!convo) throw Errors.notFound("Conversation");
      return buildInput(tx, ctx, convo, ref.message);
    });
  },
  async onComplete(tx, execution, result) {
    const r = result as SupportResult;
    const ref = execution.input_ref as { conversation_id?: string };
    if (!ref.conversation_id || typeof r.reply !== "string") return {};
    const msg: Message = {
      role: "assistant",
      content: r.reply.slice(0, 4000),
      at: new Date().toISOString(),
      citations: r.citations ?? [],
      execution_id: execution.id,
      escalated: Boolean(r.escalate),
    };
    const ticket = r.escalate ? `TCK-${execution.id.slice(0, 8).toUpperCase()}` : null;
    await tx.query(
      `update public.support_conversations
          set messages = messages || $3::jsonb,
              topic = $4,
              urgency = $5,
              status = case when $6 then 'escalated' else status end,
              ticket_ref = coalesce(ticket_ref, $7),
              escalated_at = case when $6 and escalated_at is null then now() else escalated_at end
        where id = $1 and organization_id = $2`,
      [ref.conversation_id, execution.organization_id, JSON.stringify([msg]), r.intent, r.urgency, Boolean(r.escalate), ticket],
    );
    if (r.escalate) {
      await audit(
        {
          orgId: execution.organization_id,
          actorId: null,
          action: "support.escalated",
          entityType: "support_conversation",
          entityId: ref.conversation_id,
          metadata: { reason: r.escalation_reason, ticket, urgency: r.urgency },
        },
        tx,
      );
    }
    return { result: { ...r, ticket_ref: ticket } };
  },
};
