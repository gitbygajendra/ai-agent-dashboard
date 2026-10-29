import "server-only";
import type { OrgContext } from "../../auth/context";
import { logger } from "../../logger";
import type { CrmEventInput, CrmEventResult } from "../logic/crm";
import { isConfigured } from "../../n8n/client";
import type { AgentHandler } from "../types";

export const crmHandler: AgentHandler = {
  async rebuild(_ctx, execution) {
    return (execution.input_ref as { event_input: CrmEventInput }).event_input;
  },
  async onComplete(tx, execution, result) {
    const r = result as CrmEventResult;
    if (!Array.isArray(r.actions)) return {};
    const org = execution.organization_id;
    const applied: string[] = [];
    for (const a of r.actions.slice(0, 10)) {
      if (a.type === "create_task") {
        await tx.query(
          `insert into public.activities (organization_id, contact_id, deal_id, type, subject, body, due_at, execution_id)
           values ($1, $2, $3, 'task', $4, $5, now() + ($6::int * interval '1 day'), $7)`,
          [org, a.contact_id, a.deal_id, a.subject.slice(0, 300), a.body?.slice(0, 2000) ?? null, Math.min(Math.max(a.due_in_days, 0), 60), execution.id],
        );
        applied.push(`Task: ${a.subject}`);
      } else if (a.type === "update_contact_status" && ["lead", "qualified", "customer", "unqualified", "churned"].includes(a.status)) {
        await tx.query("update public.contacts set status = $3 where id = $1 and organization_id = $2", [a.contact_id, org, a.status]);
        applied.push(`Contact status → ${a.status}`);
      } else if (a.type === "create_email_draft") {
        await tx.query(
          `insert into public.activities (organization_id, contact_id, type, subject, body, execution_id)
           values ($1, $2, 'email', $3, $4, $5)`,
          [org, a.contact_id, `Draft (not sent): ${a.subject}`.slice(0, 300), `To: ${a.to}\n\n${a.body}`.slice(0, 10000), execution.id],
        );
        applied.push(`Email draft: ${a.subject}`);
      }
    }
    return { result: { ...r, applied } };
  },
};

/**
 * Start the CRM automation for an event. Called after the CRM write has
 * committed (via `after()`), so CRM operations never wait on n8n.
 * Skipped when the CRM workflow isn't connected or the agent is disabled.
 */
export async function triggerCrmEvent(ctx: OrgContext, eventInput: CrmEventInput, entityId: string) {
  try {
    const { n8nConfig, startExecution } = await import("../executions");
    if (!isConfigured("crm-automation-agent", n8nConfig())) return;
    await startExecution(ctx, "crm-automation-agent", {
      input: { ...eventInput, sender_name: ctx.fullName },
      inputSummary: { event: eventInput.event, entity_id: entityId, name: eventInput.deal?.title ?? eventInput.contact?.name ?? null },
      inputRef: { event_input: { ...eventInput, sender_name: ctx.fullName } },
      idempotencyKey: `crm:${eventInput.event}:${entityId}:${Date.now()}`,
      trigger: "crm_event",
    });
  } catch (err) {
    // AGENT_DISABLED and similar are expected; log and move on.
    logger.warn("crm_event_not_started", { event: eventInput.event, error: (err as Error).message });
  }
}
