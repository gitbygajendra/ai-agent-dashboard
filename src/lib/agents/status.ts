import "server-only";
import type { OrgContext } from "../auth/context";
import { withUser } from "../db";
import { getIntegrationStatuses, type IntegrationStatus } from "../integrations/status";
import { AGENT_SLUGS, AGENTS, type AgentSlug } from "./registry";

export type AgentRuntimeStatus = {
  slug: AgentSlug;
  enabled: boolean;
  connection: "connected" | "not_connected" | "needs_attention";
  connectionDetail: string;
  blockedReason: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
};

/** Combines catalog, per-org agent settings, n8n configuration and recent errors. */
export async function getAgentStatuses(ctx: OrgContext): Promise<{ agents: AgentRuntimeStatus[]; integrations: IntegrationStatus[] }> {
  const [{ integrations, workflows }, rows] = await Promise.all([
    getIntegrationStatuses(ctx),
    withUser(ctx.user.id, (tx) =>
      tx.query<{ slug: AgentSlug; enabled: boolean; last_run: string | null; last_status: string | null }>(
        `select a.slug, a.enabled,
                (select max(created_at)::text from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug) as last_run,
                (select status from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug order by created_at desc limit 1) as last_status
           from public.agents a where a.organization_id = $1`,
        [ctx.orgId],
      ),
    ),
  ]);
  const n8n = integrations.find((i) => i.provider === "n8n")!;
  const agents = AGENT_SLUGS.map((slug) => {
    const row = rows.find((r) => r.slug === slug);
    const wf = workflows.find((w) => w.slug === slug)!;
    const enabled = row?.enabled ?? true;
    let connection: AgentRuntimeStatus["connection"] = "connected";
    let detail = "Runs through the master n8n workflow.";
    let blocked: string | null = null;
    if (!wf.configured) {
      connection = "not_connected";
      detail = "n8n webhook not configured (set N8N_BASE_URL and N8N_WEBHOOK_SECRET).";
      blocked = "This agent isn't connected to n8n yet. An admin needs to finish setup on the Integrations page.";
    } else if (wf.lastErrorCode) {
      connection = "needs_attention";
      detail = wf.lastError ?? "The last run hit a setup error.";
    } else if (n8n.state === "needs_attention") {
      connection = "needs_attention";
      detail = n8n.detail;
    }
    if (!enabled) blocked = "This agent is turned off in Settings.";
    return { slug, enabled, connection, connectionDetail: detail, blockedReason: blocked, lastRunAt: row?.last_run ?? null, lastStatus: row?.last_status ?? null };
  });
  return { agents, integrations };
}
