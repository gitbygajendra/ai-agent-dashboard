import "server-only";
import { z } from "zod";
import { audit } from "../audit";
import { assertCanWrite, type OrgContext } from "../auth/context";
import { withService, withUser } from "../db";
import { AppError, Errors } from "../errors";
import { sendEmail } from "../integrations/gmail";
import { logger } from "../logger";
import { getExecution } from "./executions";
import type { EmailResult } from "./logic/email";
import type { LeadResult } from "./logic/leads";
import { EXECUTION_COLUMNS, type ExecutionRow } from "./types";

/**
 * Human-in-the-loop approvals. Nothing external (emails, CRM imports) happens
 * until a person approves it here, except email categories an admin has
 * explicitly marked as trusted for automatic sending.
 */
type Decision = { status: "sent" | "skipped" | "failed"; at: string; by: string; to?: string; error?: string };
type EmailApproval = { decisions: Record<string, Decision> };

const emailItems = z.object({
  items: z
    .array(
      z.object({
        email_id: z.string().max(100),
        action: z.enum(["send", "skip"]),
        to: z.email().max(320).optional(),
        subject: z.string().trim().min(1).max(300).optional(),
        body: z.string().trim().min(1).max(20000).optional(),
      }),
    )
    .min(1)
    .max(50),
});

async function saveEmailDecisions(executionId: string, decisions: Record<string, Decision>) {
  return withService(async (tx) => {
    const row = await tx.one<ExecutionRow>(`select ${EXECUTION_COLUMNS} from public.agent_executions where id = $1 for update`, [executionId]);
    if (!row || row.status !== "awaiting_approval") return row;
    const result = row.result as EmailResult & { approval?: EmailApproval };
    const merged = { ...(result.approval?.decisions ?? {}), ...decisions };
    const draftIds = result.emails.filter((e) => e.draft).map((e) => e.id);
    // A failed send stays open so it can be retried while the run awaits approval.
    const allDecided = draftIds.every((id) => merged[id] && merged[id].status !== "failed");
    return tx.one<ExecutionRow>(
      `update public.agent_executions
          set result = $2, status = $3, completed_at = case when $3 = 'succeeded' then now() else completed_at end
        where id = $1 returning ${EXECUTION_COLUMNS}`,
      [executionId, JSON.stringify({ ...result, approval: { decisions: merged } }), allDecided ? "succeeded" : "awaiting_approval"],
    );
  });
}

async function sendDraft(orgId: string, email: EmailResult["emails"][number], override: { to?: string; subject?: string; body?: string }) {
  const to = override.to ?? email.draft?.to ?? null;
  if (!to) throw new AppError("NO_RECIPIENT", "Add a recipient address before sending.", 400);
  await sendEmail(orgId, {
    to,
    subject: override.subject ?? email.draft!.subject,
    body: override.body ?? email.draft!.body,
    threadId: email.source === "gmail" ? email.thread_id : null,
  });
  return to;
}

export async function approveEmails(ctx: OrgContext, executionId: string, raw: unknown) {
  assertCanWrite(ctx);
  const execution = await getExecution(ctx, executionId);
  if (execution.agent_slug !== "email-automation-agent") throw Errors.invalid("This run is not an email run.");
  if (execution.status !== "awaiting_approval") throw Errors.conflict("This run is not waiting for approval.");
  const { items } = emailItems.parse(raw);
  const result = execution.result as EmailResult & { approval?: EmailApproval };
  const decisions: Record<string, Decision> = {};
  const now = new Date().toISOString();
  for (const item of items) {
    const email = result.emails.find((e) => e.id === item.email_id);
    if (!email?.draft || result.approval?.decisions?.[item.email_id]?.status === "sent") continue;
    if (item.action === "skip") {
      decisions[item.email_id] = { status: "skipped", at: now, by: ctx.user.id };
      continue;
    }
    try {
      const to = await sendDraft(ctx.orgId, email, item);
      decisions[item.email_id] = { status: "sent", at: now, by: ctx.user.id, to };
      await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "email.sent", entityType: "agent_execution", entityId: executionId, metadata: { email_id: item.email_id, recipient_domain: to.split("@")[1] } });
    } catch (err) {
      decisions[item.email_id] = { status: "failed", at: now, by: ctx.user.id, error: err instanceof AppError ? err.message : "Sending failed." };
    }
  }
  return saveEmailDecisions(executionId, decisions);
}

/** Send drafts in categories an admin marked as trusted. Runs without a user. */
export async function applyEmailAutomationRules(executionId: string, categories: string[]) {
  const execution = await withService((tx) => tx.one<ExecutionRow>(`select ${EXECUTION_COLUMNS} from public.agent_executions where id = $1`, [executionId]));
  if (!execution || execution.status !== "awaiting_approval") return;
  const result = execution.result as EmailResult;
  const decisions: Record<string, Decision> = {};
  for (const email of result.emails) {
    if (!email.draft || email.source !== "gmail" || !categories.includes(email.category) || !email.draft.to) continue;
    try {
      const to = await sendDraft(execution.organization_id, email, {});
      decisions[email.id] = { status: "sent", at: new Date().toISOString(), by: "automation-rule", to };
      await audit({ orgId: execution.organization_id, actorId: null, action: "email.auto_sent", entityType: "agent_execution", entityId: executionId, metadata: { email_id: email.id, category: email.category } });
    } catch (err) {
      logger.warn("email_auto_send_failed", { execution_id: executionId, error: (err as Error).message });
    }
  }
  if (Object.keys(decisions).length) await saveEmailDecisions(executionId, decisions);
}

const leadItems = z.object({ prospect_ids: z.array(z.string().max(20)).min(1).max(1000) });

export async function approveLeads(ctx: OrgContext, executionId: string, raw: unknown) {
  assertCanWrite(ctx);
  const execution = await getExecution(ctx, executionId);
  if (execution.agent_slug !== "lead-generation-agent") throw Errors.invalid("This run is not a lead generation run.");
  if (execution.status !== "awaiting_approval") throw Errors.conflict("This run is not waiting for approval.");
  const { prospect_ids } = leadItems.parse(raw);
  const result = execution.result as LeadResult;
  const chosen = result.prospects.filter((p) => prospect_ids.includes(p.id) && p.status === "new");
  const imported = await withUser(ctx.user.id, async (tx) => {
    let count = 0;
    for (const p of chosen) {
      const row = await tx.one<{ id: string }>(
        `insert into public.contacts (organization_id, name, email, phone, company, source, status, lead_score, industry, location, company_size, owner_id, created_by)
         values ($1, $2, $3, $4, $5, 'Lead Generation Agent', 'lead', $6, $7, $8, $9, auth.uid(), auth.uid())
         on conflict (organization_id, lower(email)) where email is not null do nothing
         returning id`,
        [ctx.orgId, p.name.slice(0, 200), p.email, p.phone?.slice(0, 40) ?? null, p.company?.slice(0, 200) ?? null, p.score, p.industry, p.location, p.company_size],
      );
      if (row) count++;
    }
    return count;
  });
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "leads.imported", entityType: "agent_execution", entityId: executionId, metadata: { requested: prospect_ids.length, imported } });
  return withService((tx) =>
    tx.one<ExecutionRow>(
      `update public.agent_executions set status = 'succeeded', completed_at = now(), result = $2
        where id = $1 and status = 'awaiting_approval' returning ${EXECUTION_COLUMNS}`,
      [executionId, JSON.stringify({ ...result, approval: { imported, skipped: chosen.length - imported, approved_by: ctx.user.id, at: new Date().toISOString() } })],
    ),
  );
}

export async function rejectExecution(ctx: OrgContext, executionId: string) {
  assertCanWrite(ctx);
  const execution = await getExecution(ctx, executionId);
  if (execution.status !== "awaiting_approval") throw Errors.conflict("This run is not waiting for approval.");
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "approval.rejected", entityType: "agent_execution", entityId: executionId });
  return withService((tx) =>
    tx.one<ExecutionRow>(
      `update public.agent_executions set status = 'cancelled', completed_at = now(), error_code = 'REJECTED', error_message = 'Dismissed during review.'
        where id = $1 and status = 'awaiting_approval' returning ${EXECUTION_COLUMNS}`,
      [executionId],
    ),
  );
}
