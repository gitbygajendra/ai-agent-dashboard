import Link from "next/link";
import { BarChart3, Upload } from "lucide-react";
import { RunsTrendChart } from "@/components/charts";
import { AgentIcon } from "@/components/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, StatCard, Table, TBody, TD, TH, THead, TR, buttonVariants } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { AGENT_SLUGS, AGENTS, type AgentSlug } from "@/lib/agents/registry";
import { withUser } from "@/lib/db";
import { getOverview } from "@/lib/metrics";
import { formatCurrency, formatDuration, formatNumber, timeAgo } from "@/lib/utils";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  const ctx = await requirePageContext();
  const [overview, [perAgent, analyses]] = await Promise.all([
    getOverview(ctx),
    withUser(ctx.user.id, (tx) =>
      Promise.all([
        tx.query<{ agent_slug: AgentSlug; total: number; succeeded: number; failed: number; avg_ms: number | null; ai_used: number }>(
          `select agent_slug, count(*)::int as total,
                  count(*) filter (where status = 'succeeded')::int as succeeded,
                  count(*) filter (where status in ('failed', 'timed_out'))::int as failed,
                  avg(duration_ms) filter (where status = 'succeeded')::int as avg_ms,
                  count(*) filter (where ai_status = 'used')::int as ai_used
             from public.agent_executions where organization_id = $1 and created_at > now() - interval '30 days'
            group by agent_slug`,
          [ctx.orgId],
        ),
        tx.query<{ id: string; file_name: string | null; question: string | null; rows: number | null; revenue: string | null; change: string | null; top: string | null; completed_at: string }>(
          `select id, input_summary->>'file_name' as file_name, input_summary->>'question' as question,
                  (result->'dataset'->>'row_count')::int as rows,
                  result->'metrics'->>'revenue_total' as revenue,
                  result->'metrics'->>'period_change_pct' as change,
                  result->'charts'->'top_items'->0->>'name' as top,
                  completed_at
             from public.agent_executions
            where organization_id = $1 and agent_slug = 'data-analytics-agent' and status = 'succeeded'
            order by completed_at desc limit 20`,
          [ctx.orgId],
        ),
      ]),
    ),
  ]);
  const totals = perAgent.reduce((a, r) => ({ total: a.total + r.total, ok: a.ok + r.succeeded, failed: a.failed + r.failed }), { total: 0, ok: 0, failed: 0 });
  const successRate = totals.total ? Math.round((totals.ok / totals.total) * 1000) / 10 : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Saved dataset analyses and how your automations perform."
        actions={
          <Link href="/agents/data-analytics-agent" className={buttonVariants({ size: "sm" })}>
            <Upload /> Analyze a dataset
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Runs (30 days)" value={formatNumber(totals.total)} />
        <StatCard label="Success rate" value={successRate === null ? "—" : `${successRate}%`} tone="success" />
        <StatCard label="Datasets analyzed" value={formatNumber(analyses.length)} hint={analyses.length === 20 ? "Showing latest 20" : undefined} />
        <StatCard label="Revenue analyzed" value={formatCurrency(Number(overview.counts.revenue_analyzed), ctx.currency, true)} hint="Across all analyses" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Saved analyses</CardTitle>
          <CardDescription>Each row is a Data Analytics run. Open it to see charts, answers and the downloadable report.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {analyses.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No analyses yet"
              description="Upload a CSV or Excel file to the Data Analytics Agent."
              className="mx-5 mb-3"
              action={
                <Link href="/agents/data-analytics-agent" className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Open Data Analytics Agent
                </Link>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Dataset</TH>
                  <TH>Rows</TH>
                  <TH>Revenue</TH>
                  <TH>Latest period</TH>
                  <TH>Top item</TH>
                  <TH>Analyzed</TH>
                </TR>
              </THead>
              <TBody>
                {analyses.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <Link href={`/agents/data-analytics-agent?run=${a.id}`} className="font-medium hover:underline">
                        {a.file_name ?? "Dataset"}
                      </Link>
                      {a.question && <p className="max-w-[280px] truncate text-xs text-muted-foreground">{a.question}</p>}
                    </TD>
                    <TD className="tabular-nums">{formatNumber(a.rows)}</TD>
                    <TD className="tabular-nums">{a.revenue && Number(a.revenue) > 0 ? formatCurrency(Number(a.revenue), ctx.currency) : "—"}</TD>
                    <TD className={a.change === null ? "text-muted-foreground" : Number(a.change) >= 0 ? "text-success" : "text-danger"}>
                      {a.change === null ? "—" : `${Number(a.change) > 0 ? "+" : ""}${a.change}%`}
                    </TD>
                    <TD className="max-w-[200px] truncate">{a.top ?? "—"}</TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(a.completed_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Executions, last 14 days</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.trend.every((d) => d.succeeded + d.failed + d.other === 0) ? (
              <EmptyState title="No runs in the last 14 days" className="h-[240px]" />
            ) : (
              <RunsTrendChart data={overview.trend} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Performance by agent (30 days)</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH>Runs</TH>
                  <TH>Success</TH>
                  <TH>Avg time</TH>
                  <TH>AI used</TH>
                </TR>
              </THead>
              <TBody>
                {AGENT_SLUGS.map((slug) => {
                  const r = perAgent.find((p) => p.agent_slug === slug);
                  return (
                    <TR key={slug}>
                      <TD>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <AgentIcon icon={AGENTS[slug].icon} className="size-6 [&_svg]:size-3" />
                          {AGENTS[slug].name.replace(" Agent", "")}
                        </span>
                      </TD>
                      <TD className="tabular-nums">{r?.total ?? 0}</TD>
                      <TD className="tabular-nums">{r?.total ? `${Math.round((r.succeeded / r.total) * 100)}%` : "—"}</TD>
                      <TD className="whitespace-nowrap">{formatDuration(r?.avg_ms ?? null)}</TD>
                      <TD className="tabular-nums">{r?.total ? r.ai_used : "—"}</TD>
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
