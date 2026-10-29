import { apiContext, json } from "@/lib/api";
import { approveEmails, approveLeads, rejectExecution } from "@/lib/agents/approvals";
import { getExecution } from "@/lib/agents/executions";
import { readJson } from "@/lib/agents/handlers/shared";
import { Errors, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Approve or reject work that is waiting for a person:
 *  - email drafts: { items: [{ email_id, action: "send" | "skip", to?, subject?, body? }] }
 *  - lead imports: { prospect_ids: [...] }
 *  - either: { reject: true }
 */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await apiContext(req);
  const body = (await readJson(req, 500_000)) as Record<string, unknown>;
  if (body.reject === true) return json({ execution: await rejectExecution(ctx, id) });
  const execution = await getExecution(ctx, id);
  if (execution.agent_slug === "email-automation-agent") return json({ execution: await approveEmails(ctx, id, body) });
  if (execution.agent_slug === "lead-generation-agent") return json({ execution: await approveLeads(ctx, id, body) });
  throw Errors.invalid("This run has nothing to approve.");
});
