import Link from "next/link";
import { Activity } from "lucide-react";
import { AiBadge, AgentIcon, ExecutionStatusBadge } from "@/components/status";
import { Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR, buttonVariants } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { listExecutions } from "@/lib/agents/executions";
import { AGENT_SLUGS, AGENTS, isAgentSlug } from "@/lib/agents/registry";
import type { ExecutionStatus } from "@/lib/agents/types";
import { cn, formatDateTime, formatDuration } from "@/lib/utils";

export const metadata = { title: "Workflow Runs" };

const STATUSES: { value: ExecutionStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "running", label: "Running" },
  { value: "awaiting_approval", label: "Needs approval" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "timed_out", label: "Timed out" },
];

const PAGE = 25;

export default async function RunsPage({ searchParams }: PageProps<"/runs">) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const agent = typeof sp.agent === "string" && isAgentSlug(sp.agent) ? sp.agent : undefined;
  const status = STATUSES.find((s) => s.value && s.value === sp.status)?.value as ExecutionStatus | undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const runs = await listExecutions(ctx, { agent, status, limit: PAGE + 1, offset: (page - 1) * PAGE });
  const hasNext = runs.length > PAGE;
  const href = (o: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    const merged = { agent, status, page: undefined as number | undefined, ...o };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && String(v) !== "") q.set(k, String(v));
    const s = q.toString();
    return `/runs${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Workflow Runs" description="Every agent execution, its status, errors and results." />

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <Link
              key={s.label}
              href={href({ status: s.value || undefined })}
              role="tab"
              aria-selected={(status ?? "") === s.value}
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium", (status ?? "") === s.value ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link href={href({ agent: undefined })} className={cn(buttonVariants({ size: "sm", variant: agent ? "outline" : "secondary" }))}>
            All agents
          </Link>
          {AGENT_SLUGS.map((s) => (
            <Link key={s} href={href({ agent: s })} className={cn(buttonVariants({ size: "sm", variant: agent === s ? "secondary" : "outline" }))}>
              {AGENTS[s].name.replace(" Agent", "")}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {runs.length === 0 ? (
          <EmptyState icon={Activity} title="No runs match" description="Runs appear here as soon as an agent starts." className="m-5" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH>Status</TH>
                <TH>Details</TH>
                <TH>Trigger</TH>
                <TH>Started</TH>
                <TH>Duration</TH>
              </TR>
            </THead>
            <TBody>
              {runs.slice(0, PAGE).map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link href={`/runs/${r.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <AgentIcon icon={AGENTS[r.agent_slug].icon} className="size-6 [&_svg]:size-3" />
                      <span className="whitespace-nowrap">{AGENTS[r.agent_slug].name}</span>
                    </Link>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <ExecutionStatusBadge status={r.status} />
                      <AiBadge status={r.ai_status} />
                    </div>
                  </TD>
                  <TD className="max-w-[340px]">
                    <p className="truncate text-sm">{r.error_message ?? String(r.input_summary?.file_name ?? r.input_summary?.question ?? r.input_summary?.message ?? r.input_summary?.event ?? "—")}</p>
                    {r.error_code && <p className="font-mono text-[11px] text-danger">{r.error_code}</p>}
                  </TD>
                  <TD className="capitalize text-muted-foreground">
                    {r.trigger.replace("_", " ")}
                    {r.attempt > 1 ? ` #${r.attempt}` : ""}
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.created_at)}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDuration(r.duration_ms)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <div className="flex justify-between">
        {page > 1 ? (
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href({ page: page - 1 })}>
            Previous
          </Link>
        ) : (
          <span />
        )}
        {hasNext && (
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href({ page: page + 1 })}>
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
