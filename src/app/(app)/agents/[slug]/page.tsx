import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Settings2 } from "lucide-react";
import { AgentWorkspace } from "@/components/agents/workspace";
import type { ExecutionDetail } from "@/components/agents/types";
import { AgentIcon, ConnectionBadge, ImplementationBadge } from "@/components/status";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { canWrite, isAdmin, requirePageContext } from "@/lib/auth/context";
import { getExecution, listExecutions } from "@/lib/agents/executions";
import { AGENTS, INTEGRATIONS, isAgentSlug } from "@/lib/agents/registry";
import { getAgentStatuses } from "@/lib/agents/status";
import { env } from "@/lib/env";
import { WORKFLOW_LOGIC } from "@/lib/agents/logic";

export async function generateMetadata({ params }: PageProps<"/agents/[slug]">) {
  const { slug } = await params;
  return { title: isAgentSlug(slug) ? AGENTS[slug].name : "Agent" };
}

export default async function AgentPage({ params, searchParams }: PageProps<"/agents/[slug]">) {
  const { slug } = await params;
  if (!isAgentSlug(slug)) notFound();
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const agent = AGENTS[slug];
  const [{ agents, integrations }, history] = await Promise.all([getAgentStatuses(ctx), listExecutions(ctx, { agent: slug, limit: 15 })]);
  const status = agents.find((a) => a.slug === slug)!;

  let initial: ExecutionDetail | null = null;
  const runId = typeof sp.run === "string" ? sp.run : history[0]?.id;
  if (runId) {
    try {
      const e = await getExecution(ctx, runId);
      if (e.agent_slug === slug) initial = e as unknown as ExecutionDetail;
    } catch {
      initial = null;
    }
  }

  const e = env();
  const providers = [...agent.requires.map((p) => ({ p, required: true })), ...agent.optional.map((p) => ({ p, required: false }))];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <AgentIcon icon={agent.icon} className="size-11" />
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{agent.description}</p>
            <div className="flex flex-wrap gap-1.5">
              <ConnectionBadge state={status.enabled ? status.connection : "not_connected"} />
              <ImplementationBadge level={agent.implementation} />
            </div>
          </div>
        </div>
      </div>

      {agent.implementation !== "implemented" && <Alert tone="info" title="Implementation status">{agent.implementationNote}</Alert>}
      {status.connection === "needs_attention" && status.enabled && <Alert tone="warning" title="Needs attention">{status.connectionDetail}</Alert>}

      <AgentWorkspace
        slug={slug}
        canWrite={canWrite(ctx)}
        currency={ctx.currency}
        blockedReason={status.blockedReason}
        initialHistory={history as never}
        initialExecution={initial}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="size-4 text-muted-foreground" /> Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">Agent</dt>
              <dd>{status.enabled ? "Enabled" : "Turned off"}</dd>
              <dt className="text-muted-foreground">{e.ENGINE === "builtin" ? "Engine" : "n8n workflow"}</dt>
              <dd className="break-all">
                {e.ENGINE === "builtin" ? "Built-in (runs inside this app)" : <code className="text-xs">n8n/agent-dashboard-master.json</code>}
                <span className="block text-xs text-muted-foreground">{status.connectionDetail}</span>
              </dd>
              <dt className="text-muted-foreground">AI model</dt>
              <dd>{e.AI_ENABLED === "true" ? <code className="text-xs">{e.AI_MODEL}</code> : "Off (computed results only)"}</dd>
            </dl>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">How a run works, step by step</p>
              <ol className="space-y-1">
                {["validate input", ...WORKFLOW_LOGIC[slug].stageNames, "build AI prompt", "AI writes the text (optional)", "save results"].map((step, i) => (
                  <li key={step} className="flex items-center gap-2 text-xs">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium">{i + 1}</span>
                    <span className="capitalize">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
            {isAdmin(ctx) && (
              <p className="text-xs text-muted-foreground">
                Turn agents on or off and set automation rules in <Link className="text-primary hover:underline" href="/settings">Settings</Link>.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Connections & capabilities</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="space-y-2">
              {providers.map(({ p, required }) => {
                const s = integrations.find((i) => i.provider === p);
                return (
                  <li key={p} className="flex items-center justify-between gap-3">
                    <span>
                      {INTEGRATIONS[p].name} <span className="text-xs text-muted-foreground">{required ? "required" : "optional"}</span>
                    </span>
                    <ConnectionBadge state={s?.state ?? "not_connected"} />
                  </li>
                );
              })}
            </ul>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {agent.capabilities.map((c) => (
                <li key={c} className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-3.5 text-success" /> {c}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Manage connections on the <Link className="text-primary hover:underline" href="/integrations">Integrations</Link> page.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
