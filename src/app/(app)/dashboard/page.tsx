import Link from "next/link";
import { Activity, Bot, CheckCircle2, IndianRupee, Mail, Users, XCircle, CircleDollarSign } from "lucide-react";
import { PipelineChart, RunsTrendChart } from "@/components/charts";
import { AgentIcon, ConnectionBadge, ExecutionStatusBadge, ImplementationBadge } from "@/components/status";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR, buttonVariants } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { AGENTS } from "@/lib/agents/registry";
import { getAgentStatuses } from "@/lib/agents/status";
import { getOverview } from "@/lib/metrics";
import { formatCurrency, formatNumber, timeAgo } from "@/lib/utils";

export const metadata = { title: "Overview" };

export default async function DashboardPage() {
  const ctx = await requirePageContext();
  const [data, { agents, integrations }] = await Promise.all([getOverview(ctx), getAgentStatuses(ctx)]);
  const c = data.counts;
  const active = agents.filter((a) => a.enabled && a.connection !== "not_connected").length;
  const n8n = integrations.find((i) => i.provider === "n8n")!;
  const totalRuns = data.trend.reduce((a, d) => a + d.succeeded + d.failed + d.other, 0);
  const pipelineDeals = data.pipeline.reduce((a, s) => a + s.count, 0);
  const hasDemo = data.demo.contacts + data.demo.deals > 0;
  const CurrencyIcon = ctx.currency === "INR" ? IndianRupee : CircleDollarSign;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome${ctx.fullName ? `, ${ctx.fullName.split(" ")[0]}` : ""}`}
        description={`${ctx.orgName} · all figures come from your workspace's records.`}
        actions={
          <Link href="/agents" className={buttonVariants({ size: "sm" })}>
            <Bot /> Open agents
          </Link>
        }
      />

      {n8n.state !== "connected" && (
        <Alert
          tone={n8n.state === "needs_attention" ? "warning" : "info"}
          title={n8n.state === "needs_attention" ? "n8n needs attention" : "Connect n8n to run agents"}
          action={
            <Link href="/integrations" className={buttonVariants({ size: "sm", variant: "outline" })}>
              Integrations
            </Link>
          }
        >
          {n8n.detail}
        </Alert>
      )}
      {hasDemo && (
        <Alert tone="warning" title="Demo records included">
          {data.demo.contacts} demo contacts and {data.demo.deals} demo deals are counted below. Remove them from the CRM page when you start using real data.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total leads & contacts" value={formatNumber(c.leads)} icon={Users} hint={<Link href="/crm" className="hover:underline">View CRM</Link>} />
        <StatCard label="Revenue analyzed" value={formatCurrency(Number(c.revenue_analyzed), ctx.currency, true)} icon={CurrencyIcon} hint="Sum across analyzed datasets" />
        <StatCard label="Emails processed" value={formatNumber(c.emails_processed)} icon={Mail} hint="By the Email agent" />
        <StatCard label="Active automations" value={`${active} / 7`} icon={Activity} tone="primary" hint="Agents enabled and connected" />
        <StatCard label="Successful runs" value={formatNumber(c.succeeded)} icon={CheckCircle2} tone="success" hint="Last 30 days" />
        <StatCard label="Failed runs" value={formatNumber(c.failed)} icon={XCircle} tone={c.failed ? "danger" : "neutral"} hint={c.awaiting ? `${c.awaiting} awaiting approval` : "Last 30 days"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Workflow executions</CardTitle>
            <CardDescription>Runs per day, last 14 days</CardDescription>
          </CardHeader>
          <CardContent>
            {totalRuns === 0 ? (
              <EmptyState icon={Activity} title="No runs yet" description="Run an agent to see execution trends here." className="h-[240px]" />
            ) : (
              <RunsTrendChart data={data.trend} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lead pipeline</CardTitle>
            <CardDescription>Deals by stage</CardDescription>
          </CardHeader>
          <CardContent>
            {pipelineDeals === 0 ? (
              <EmptyState
                icon={Users}
                title="No deals yet"
                description="Add deals in the CRM (or load clearly labeled demo data) to see your pipeline."
                className="h-[240px]"
                action={
                  <Link href="/crm?tab=pipeline" className={buttonVariants({ size: "sm", variant: "outline" })}>
                    Open pipeline
                  </Link>
                }
              />
            ) : (
              <PipelineChart data={data.pipeline} currency={ctx.currency} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Recent agent activity</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            {data.recent.length === 0 ? (
              <p className="px-5 pb-4 text-sm text-muted-foreground">Nothing yet. Agent runs will appear here.</p>
            ) : (
              <ul className="divide-y">
                {data.recent.map((r) => {
                  const a = AGENTS[r.agent_slug as keyof typeof AGENTS];
                  return (
                    <li key={r.id}>
                      <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-muted/40">
                        {a && <AgentIcon icon={a.icon} className="size-7 [&_svg]:size-3.5" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{a?.name ?? r.agent_slug}</p>
                          <p className="truncate text-xs text-muted-foreground">{r.status === "failed" ? r.error_message : String(r.input_summary?.file_name ?? r.input_summary?.question ?? r.input_summary?.event ?? r.trigger)}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <ExecutionStatusBadge status={r.status} />
                          <span className="text-[11px] text-muted-foreground">{timeAgo(r.created_at)}</span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Agent status</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH>Connection</TH>
                  <TH>Build</TH>
                  <TH>Runs (30d)</TH>
                  <TH>Last run</TH>
                </TR>
              </THead>
              <TBody>
                {agents.map((s) => {
                  const a = AGENTS[s.slug];
                  const stats = data.agents.find((x) => x.agent_slug === s.slug);
                  return (
                    <TR key={s.slug}>
                      <TD>
                        <Link href={`/agents/${s.slug}`} className="flex items-center gap-2 font-medium hover:underline">
                          <AgentIcon icon={a.icon} className="size-6 [&_svg]:size-3" />
                          <span className="whitespace-nowrap">{a.name.replace(" Agent", "")}</span>
                        </Link>
                      </TD>
                      <TD>
                        <ConnectionBadge state={s.enabled ? s.connection : "not_connected"} />
                      </TD>
                      <TD>
                        <ImplementationBadge level={a.implementation} />
                      </TD>
                      <TD className="tabular-nums">
                        {stats?.runs_30d ?? 0}
                        {stats?.failed_30d ? <span className="text-danger"> ({stats.failed_30d} failed)</span> : null}
                      </TD>
                      <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(s.lastRunAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
