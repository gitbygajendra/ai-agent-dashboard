import "server-only";
import type { OrgContext } from "./auth/context";
import { withUser } from "./db";
import type { BusinessMetrics } from "./agents/logic/advisory";
import { AGENT_SLUGS } from "./agents/registry";

const STALE_DAYS = 14;

/** Business metrics computed from the organization's records (RLS-scoped). */
export async function getBusinessMetrics(ctx: OrgContext): Promise<BusinessMetrics> {
  return withUser(ctx.user.id, async (tx) => {
    const org = [ctx.orgId];
    const [status, sources, tasks, demo, stages, stale, analytics, finance, runs] = await Promise.all([
      tx.query<{ status: string; n: number }>("select status, count(*)::int as n from public.contacts where organization_id = $1 group by status", org),
      tx.query<{ source: string; total: number; customers: number }>(
        `select coalesce(nullif(source, ''), 'Unknown') as source, count(*)::int as total,
                count(*) filter (where status = 'customer')::int as customers
           from public.contacts where organization_id = $1 group by 1 order by total desc limit 20`,
        org,
      ),
      tx.one<{ open: number; overdue: number }>(
        `select count(*) filter (where completed_at is null)::int as open,
                count(*) filter (where completed_at is null and due_at < now())::int as overdue
           from public.activities where organization_id = $1 and type in ('task', 'reminder')`,
        org,
      ),
      tx.one<{ n: number }>("select (select count(*) from public.contacts where organization_id = $1 and is_demo)::int as n", org),
      tx.query<{ stage: string; count: number; value: string }>(
        "select stage, count(*)::int as count, coalesce(sum(value), 0)::text as value from public.deals where organization_id = $1 group by stage",
        org,
      ),
      tx.one<{ n: number; value: string }>(
        `select count(*)::int as n, coalesce(sum(value), 0)::text as value from public.deals
          where organization_id = $1 and stage not in ('won', 'lost') and updated_at < now() - interval '${STALE_DAYS} days'`,
        org,
      ),
      tx.one<{ result: Record<string, unknown>; completed_at: string; name: string }>(
        `select result, completed_at::text, coalesce(input_summary->>'file_name', 'dataset') as name
           from public.agent_executions
          where organization_id = $1 and agent_slug = 'data-analytics-agent' and status = 'succeeded'
          order by completed_at desc limit 1`,
        org,
      ),
      tx.one<{ result: Record<string, unknown>; completed_at: string }>(
        `select result, completed_at::text from public.agent_executions
          where organization_id = $1 and agent_slug = 'finance-audit-agent' and status = 'succeeded'
          order by completed_at desc limit 1`,
        org,
      ),
      tx.one<{ total: number; failed: number }>(
        `select count(*)::int as total, count(*) filter (where status in ('failed', 'timed_out'))::int as failed
           from public.agent_executions where organization_id = $1 and created_at > now() - interval '30 days'`,
        org,
      ),
    ]);

    const byStatus = Object.fromEntries(status.map((s) => [s.status, s.n]));
    const byStage = stages.map((s) => ({ stage: s.stage, count: s.count, value: Number(s.value) }));
    const stage = (name: string) => byStage.find((s) => s.stage === name);
    const open = byStage.filter((s) => s.stage !== "won" && s.stage !== "lost");

    let analyticsMetrics: BusinessMetrics["analytics"] = null;
    if (analytics?.result) {
      const r = analytics.result as {
        metrics?: { revenue_total?: number; period_change_pct?: number | null };
        charts?: { granularity?: string; top_items?: { name: string; share_pct: number }[] };
      };
      const top = r.charts?.top_items ?? [];
      analyticsMetrics = {
        dataset: analytics.name,
        analyzed_at: analytics.completed_at,
        revenue_total: Number(r.metrics?.revenue_total ?? 0),
        period_change_pct: r.metrics?.period_change_pct ?? null,
        granularity: r.charts?.granularity ?? "period",
        top_item: top[0] ? { name: top[0].name, share_pct: top[0].share_pct } : null,
        top3_share_pct: top.length >= 3 ? Math.round(top.slice(0, 3).reduce((a, t) => a + t.share_pct, 0) * 10) / 10 : null,
      };
    }
    let financeMetrics: BusinessMetrics["finance"] = null;
    if (finance?.result) {
      const r = finance.result as {
        summary?: { income_total?: number; expense_total?: number; net_profit?: number };
        findings?: { severity: string }[];
        categories?: { category: string; type: string; total: number }[];
      };
      const topExpense = (r.categories ?? []).filter((c) => c.type === "expense").sort((a, b) => b.total - a.total)[0];
      financeMetrics = {
        analyzed_at: finance.completed_at,
        income_total: Number(r.summary?.income_total ?? 0),
        expense_total: Number(r.summary?.expense_total ?? 0),
        net_profit: Number(r.summary?.net_profit ?? 0),
        high_findings: (r.findings ?? []).filter((f) => f.severity === "high").length,
        top_expense_category: topExpense ? { category: topExpense.category, total: topExpense.total } : null,
      };
    }

    return {
      crm: {
        contacts_total: status.reduce((a, s) => a + s.n, 0),
        by_status: byStatus,
        by_source: sources,
        overdue_tasks: tasks?.overdue ?? 0,
        open_tasks: tasks?.open ?? 0,
        demo_records: demo?.n ?? 0,
      },
      deals: {
        open_count: open.reduce((a, s) => a + s.count, 0),
        open_value: open.reduce((a, s) => a + s.value, 0),
        won_count: stage("won")?.count ?? 0,
        won_value: stage("won")?.value ?? 0,
        lost_count: stage("lost")?.count ?? 0,
        by_stage: byStage,
        stale_count: stale?.n ?? 0,
        stale_value: Number(stale?.value ?? 0),
        stale_days: STALE_DAYS,
      },
      analytics: analyticsMetrics,
      finance: financeMetrics,
      automation: { runs_30d: runs?.total ?? 0, failed_30d: runs?.failed ?? 0 },
    };
  });
}

export type OverviewData = Awaited<ReturnType<typeof getOverview>>;

/** Everything the Overview page shows, from real records only. */
export async function getOverview(ctx: OrgContext) {
  return withUser(ctx.user.id, async (tx) => {
    const org = [ctx.orgId];
    const [counts, trend, pipeline, recent, agentStats, demo] = await Promise.all([
      tx.one<{
        leads: number;
        revenue_analyzed: string;
        emails_processed: number;
        succeeded: number;
        failed: number;
        running: number;
        awaiting: number;
      }>(
        `select
           (select count(*) from public.contacts where organization_id = $1)::int as leads,
           (select coalesce(sum((result->'metrics'->>'revenue_total')::numeric), 0)
              from public.agent_executions
             where organization_id = $1 and agent_slug = 'data-analytics-agent' and status = 'succeeded')::text as revenue_analyzed,
           (select coalesce(sum((result->>'emails_processed')::int), 0)
              from public.agent_executions
             where organization_id = $1 and agent_slug = 'email-automation-agent'
               and status in ('succeeded', 'awaiting_approval'))::int as emails_processed,
           (select count(*) from public.agent_executions where organization_id = $1 and status = 'succeeded'
               and created_at > now() - interval '30 days')::int as succeeded,
           (select count(*) from public.agent_executions where organization_id = $1 and status in ('failed', 'timed_out')
               and created_at > now() - interval '30 days')::int as failed,
           (select count(*) from public.agent_executions where organization_id = $1 and status in ('queued', 'running'))::int as running,
           (select count(*) from public.agent_executions where organization_id = $1 and status = 'awaiting_approval')::int as awaiting`,
        org,
      ),
      tx.query<{ day: string; succeeded: number; failed: number; other: number }>(
        `select to_char(d.day, 'YYYY-MM-DD') as day,
                count(e.id) filter (where e.status = 'succeeded')::int as succeeded,
                count(e.id) filter (where e.status in ('failed', 'timed_out'))::int as failed,
                count(e.id) filter (where e.status not in ('succeeded', 'failed', 'timed_out'))::int as other
           from generate_series(current_date - 13, current_date, interval '1 day') as d(day)
           left join public.agent_executions e
             on e.organization_id = $1 and e.created_at >= d.day and e.created_at < d.day + interval '1 day'
          group by d.day order by d.day`,
        org,
      ),
      tx.query<{ stage: string; count: number; value: string }>(
        "select stage, count(*)::int as count, coalesce(sum(value), 0)::text as value from public.deals where organization_id = $1 group by stage",
        org,
      ),
      tx.query<{ id: string; agent_slug: string; status: string; trigger: string; created_at: string; error_message: string | null; input_summary: Record<string, unknown> }>(
        `select id, agent_slug, status, trigger, created_at, error_message, input_summary
           from public.agent_executions where organization_id = $1 order by created_at desc limit 8`,
        org,
      ),
      tx.query<{ agent_slug: string; enabled: boolean; last_run: string | null; last_status: string | null; runs_30d: number; failed_30d: number }>(
        `select a.slug as agent_slug, a.enabled,
                (select max(created_at)::text from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug) as last_run,
                (select status from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug order by created_at desc limit 1) as last_status,
                (select count(*) from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug and e.created_at > now() - interval '30 days')::int as runs_30d,
                (select count(*) from public.agent_executions e where e.organization_id = a.organization_id and e.agent_slug = a.slug and e.status in ('failed', 'timed_out') and e.created_at > now() - interval '30 days')::int as failed_30d
           from public.agents a where a.organization_id = $1`,
        org,
      ),
      tx.one<{ contacts: number; deals: number }>(
        `select (select count(*) from public.contacts where organization_id = $1 and is_demo)::int as contacts,
                (select count(*) from public.deals where organization_id = $1 and is_demo)::int as deals`,
        org,
      ),
    ]);
    const order = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"];
    return {
      counts: counts!,
      trend,
      pipeline: order.map((stage) => {
        const s = pipeline.find((p) => p.stage === stage);
        return { stage, count: s?.count ?? 0, value: Number(s?.value ?? 0) };
      }),
      recent,
      agents: AGENT_SLUGS.map((slug) => agentStats.find((a) => a.agent_slug === slug) ?? { agent_slug: slug, enabled: true, last_run: null, last_status: null, runs_30d: 0, failed_30d: 0 }),
      demo: demo!,
    };
  });
}
