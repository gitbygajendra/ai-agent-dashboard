import "server-only";
import type { OrgContext } from "../auth/context";
import { withUser } from "../db";
import { env } from "../env";
import { n8nConfig } from "../agents/executions";
import { AGENT_SLUGS, AGENTS, type AgentSlug, type IntegrationProvider } from "../agents/registry";
import { checkN8nHealth, isConfigured } from "../n8n/client";
import { gmailConfigured } from "./gmail";

export type ConnectionState = "connected" | "not_connected" | "needs_attention";

export type IntegrationStatus = {
  provider: IntegrationProvider;
  state: ConnectionState;
  detail: string;
  account: string | null;
  lastCheckedAt: string | null;
  canConnect: boolean;
};

let healthCache: { at: number; ok: boolean; message: string } | null = null;

async function n8nHealth() {
  if (healthCache && Date.now() - healthCache.at < 30_000) return healthCache;
  const h = await checkN8nHealth(env().N8N_BASE_URL);
  healthCache = { at: Date.now(), ...h };
  return healthCache;
}

const CONFIG_ERRORS = ["N8N_AUTH_FAILED", "N8N_WORKFLOW_NOT_FOUND", "N8N_NOT_CONFIGURED", "N8N_UNREACHABLE"];

export async function getIntegrationStatuses(ctx: OrgContext): Promise<{
  integrations: IntegrationStatus[];
  workflows: { slug: AgentSlug; configured: boolean; lastError: string | null; lastErrorCode: string | null }[];
}> {
  const e = env();
  const cfg = n8nConfig();
  const [rows, lastErrors, aiRuns] = await withUser(ctx.user.id, (tx) =>
    Promise.all([
      tx.query<{ provider: IntegrationProvider; status: ConnectionState; account_label: string | null; last_checked_at: string | null; last_error: string | null }>(
        "select provider, status, account_label, last_checked_at::text, last_error from public.integrations where organization_id = $1",
        [ctx.orgId],
      ),
      tx.query<{ agent_slug: AgentSlug; error_code: string | null; error_message: string | null; status: string }>(
        `select distinct on (agent_slug) agent_slug, error_code, error_message, status
           from public.agent_executions where organization_id = $1 order by agent_slug, created_at desc`,
        [ctx.orgId],
      ),
      tx.query<{ ai_status: string; created_at: string }>(
        `select ai_status, created_at::text from public.agent_executions
          where organization_id = $1 and ai_status in ('used', 'unavailable') order by created_at desc limit 1`,
        [ctx.orgId],
      ),
    ]),
  );
  const row = (p: IntegrationProvider) => rows.find((r) => r.provider === p);

  const workflows = AGENT_SLUGS.map((slug) => {
    const last = lastErrors.find((l) => l.agent_slug === slug);
    const configError = last && last.status === "failed" && last.error_code && CONFIG_ERRORS.includes(last.error_code);
    return { slug, configured: isConfigured(slug, cfg), lastError: configError ? last!.error_message : null, lastErrorCode: configError ? last!.error_code : null };
  });

  // n8n: configured in env + reachable + no recent auth/workflow errors
  let n8n: IntegrationStatus;
  if (!e.N8N_BASE_URL && !Object.values(cfg.webhookUrls).some(Boolean)) {
    n8n = { provider: "n8n", state: "not_connected", detail: "N8N_BASE_URL is not set.", account: null, lastCheckedAt: null, canConnect: false };
  } else if (!e.N8N_WEBHOOK_SECRET) {
    n8n = { provider: "n8n", state: "needs_attention", detail: "N8N_WEBHOOK_SECRET is not set; webhooks can't be authenticated.", account: e.N8N_BASE_URL ?? null, lastCheckedAt: null, canConnect: false };
  } else {
    const h = e.N8N_BASE_URL ? await n8nHealth() : { ok: true, message: "Using per-agent webhook URLs." };
    const broken = workflows.filter((w) => w.lastErrorCode);
    n8n = {
      provider: "n8n",
      state: !h.ok ? "needs_attention" : broken.length ? "needs_attention" : "connected",
      detail: !h.ok ? h.message : broken.length ? `${broken.length} workflow(s) reported setup errors: ${broken.map((b) => AGENTS[b.slug].name).join(", ")}.` : h.message,
      account: e.N8N_BASE_URL ?? null,
      lastCheckedAt: new Date().toISOString(),
      canConnect: false,
    };
  }

  // AI model: credential lives in n8n, so infer from the most recent run that tried to use it.
  const lastAi = aiRuns[0];
  const llm: IntegrationStatus =
    e.AI_ENABLED !== "true"
      ? { provider: "llm", state: "not_connected", detail: "AI_ENABLED=false: agents return computed results only.", account: e.AI_MODEL, lastCheckedAt: null, canConnect: false }
      : !lastAi
        ? { provider: "llm", state: "not_connected", detail: `Model ${e.AI_MODEL}. Not verified yet: give n8n the API key (GROQ_API_KEY / ANTHROPIC_API_KEY, or the "AI API Key" credential on n8n Cloud) and run an agent.`, account: e.AI_MODEL, lastCheckedAt: null, canConnect: false }
        : lastAi.ai_status === "used"
          ? { provider: "llm", state: "connected", detail: `Model ${e.AI_MODEL}. Last AI step succeeded.`, account: e.AI_MODEL, lastCheckedAt: lastAi.created_at, canConnect: false }
          : { provider: "llm", state: "needs_attention", detail: "The last AI step failed (missing/invalid credential in n8n, or a refusal). Results fell back to computed summaries.", account: e.AI_MODEL, lastCheckedAt: lastAi.created_at, canConnect: false };

  const g = row("gmail");
  const gmail: IntegrationStatus = !gmailConfigured()
    ? { provider: "gmail", state: "not_connected", detail: "Server is missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ENCRYPTION_KEY.", account: null, lastCheckedAt: null, canConnect: false }
    : { provider: "gmail", state: g?.status ?? "not_connected", detail: g?.last_error ?? (g?.status === "connected" ? "Connected with read and send access." : "Not connected."), account: g?.account_label ?? null, lastCheckedAt: g?.last_checked_at ?? null, canConnect: true };

  const simple = (p: IntegrationProvider, missing: string): IntegrationStatus => {
    const r = row(p);
    return { provider: p, state: r?.status ?? "not_connected", detail: r?.last_error ?? (r?.status === "connected" ? "Connected." : missing), account: r?.account_label ?? null, lastCheckedAt: r?.last_checked_at ?? null, canConnect: false };
  };

  return {
    integrations: [n8n, llm, gmail, simple("lead_provider", "No provider connected. CSV import works without one."), simple("order_system", "No order system connected. The chatbot escalates order questions.")],
    workflows,
  };
}
