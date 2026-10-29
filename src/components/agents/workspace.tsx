"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, Circle, ExternalLink, History, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { AiBadge, ExecutionStatusBadge } from "@/components/status";
import type { AgentSlug } from "@/lib/agents/registry";
import { api, cn, formatDateTime, formatDuration, newIdempotencyKey, timeAgo } from "@/lib/utils";
import { PANELS } from "./panel-registry";
import type { ExecutionDetail } from "./types";
import { useExecution } from "./use-execution";

type HistoryRow = Omit<ExecutionDetail, "result" | "input_ref">;

function summarizeInput(row: { input_summary: Record<string, unknown> }) {
  const s = row.input_summary ?? {};
  const parts = [s.file_name, s.question, s.message, s.event, s.mode && `${s.mode} (${s.email_count ?? 0} emails)`]
    .filter((v) => typeof v === "string" && v)
    .map((v) => String(v));
  const tx = s.transactions as { file_name?: string } | undefined;
  if (tx?.file_name) parts.unshift(tx.file_name);
  return parts.join(" · ") || "—";
}

function Progress({ execution }: { execution: ExecutionDetail }) {
  const [now, setNow] = useState(() => Date.now());
  const active = execution.status === "queued" || execution.status === "running";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const elapsed = Math.max(0, Math.round((now - new Date(execution.started_at ?? execution.created_at).getTime()) / 1000));
  const final = !active;
  const failed = ["failed", "timed_out", "cancelled"].includes(execution.status);
  const steps = [
    { label: "Request validated", done: true },
    { label: "Sent to n8n", done: execution.status !== "queued" },
    { label: "Workflow running", done: final, active: execution.status === "running" },
    { label: failed ? "Stopped" : execution.status === "awaiting_approval" ? "Waiting for your approval" : "Results saved", done: final, failed },
  ];
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4" aria-label="Run progress">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2 text-sm">
          {s.failed ? (
            <XCircle className="size-4 text-danger" />
          ) : s.done ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : s.active ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <Circle className="size-4 text-muted-foreground/50" />
          )}
          <span className={cn(!s.done && !s.active && "text-muted-foreground")}>{s.label}</span>
        </li>
      ))}
      {active && <li className="text-xs text-muted-foreground sm:ml-auto">{elapsed}s elapsed</li>}
    </ol>
  );
}

const ERROR_HELP: Record<string, string> = {
  N8N_NOT_CONFIGURED: "Connect n8n on the Integrations page, then retry.",
  N8N_UNREACHABLE: "Start your n8n instance or check N8N_BASE_URL, then retry.",
  N8N_AUTH_FAILED: "The webhook secret in n8n doesn't match N8N_WEBHOOK_SECRET.",
  N8N_WORKFLOW_NOT_FOUND: "Import this agent's workflow into n8n and publish it.",
  TIMED_OUT: "Open the n8n execution log to see where it stopped.",
};

export function AgentWorkspace({
  slug,
  canWrite,
  currency,
  blockedReason,
  initialHistory,
  initialExecution,
}: {
  slug: AgentSlug;
  canWrite: boolean;
  currency: string;
  blockedReason: string | null;
  initialHistory: HistoryRow[];
  initialExecution: ExecutionDetail | null;
}) {
  const router = useRouter();
  const panel = PANELS[slug];
  const { execution, select, pollError, isActive } = useExecution(initialExecution);
  const [history, setHistory] = useState<HistoryRow[]>(initialHistory);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Refresh history whenever the selected run changes state.
  useEffect(() => {
    let cancelled = false;
    api<{ executions: HistoryRow[] }>(`/api/executions?agent=${slug}&limit=15`)
      .then(({ executions }) => {
        if (!cancelled) setHistory(executions);
      })
      .catch(() => {
        /* history is secondary; keep the old list */
      });
    return () => {
      cancelled = true;
    };
  }, [slug, execution?.id, execution?.status]);

  useEffect(() => {
    if (!execution) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("run") !== execution.id) {
      url.searchParams.set("run", execution.id);
      window.history.replaceState(null, "", url);
    }
  }, [execution]);

  async function open(id: string) {
    setLoadingId(id);
    try {
      const { execution: e } = await api<{ execution: ExecutionDetail }>(`/api/executions/${id}`);
      select(e);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setLoadingId(null);
    }
  }

  async function retry() {
    if (!execution) return;
    setRetrying(true);
    try {
      const { execution: e } = await api<{ execution: ExecutionDetail }>(`/api/executions/${execution.id}/retry`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      select(e);
      toast("Retry started", "info");
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setRetrying(false);
    }
  }

  const failed = execution && ["failed", "timed_out"].includes(execution.status);
  const Input = panel.InputPanel;
  const Result = panel.ResultView;
  const Extras = panel.Extras;

  return (
    <div className="space-y-6">
      <div className={cn("grid gap-6", panel.layout === "stacked" ? "grid-cols-1" : "xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]")}>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{panel.inputTitle}</CardTitle>
            <CardDescription>{panel.inputDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <Input
              slug={slug}
              canWrite={canWrite}
              currency={currency}
              blockedReason={blockedReason}
              current={execution}
              onStarted={(e) => {
                select(e);
                router.refresh();
              }}
            />
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {!execution ? (
            <EmptyState
              icon={History}
              title="No run selected"
              description={blockedReason ? "This agent can't run until its setup is complete." : "Start a run on the left, or open a previous run from the history below."}
            />
          ) : (
            <Card>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ExecutionStatusBadge status={execution.status} />
                    <AiBadge status={execution.ai_status} />
                    {execution.attempt > 1 && <span className="text-xs text-muted-foreground">Attempt {execution.attempt}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatDateTime(execution.created_at)}</span>
                    {execution.duration_ms !== null && <span>· {formatDuration(execution.duration_ms)}</span>}
                    <Link href={`/runs/${execution.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                      Details <ExternalLink className="size-3" />
                    </Link>
                  </div>
                </div>
                <Progress execution={execution} />
              </CardHeader>
              <CardContent className="space-y-3">
                {isActive && (
                  <p className="text-sm text-muted-foreground">
                    n8n is working on this. You can leave this page; the run keeps going and appears in Workflow Runs.
                  </p>
                )}
                {pollError && <Alert tone="warning">Lost connection while checking status ({pollError}). Retrying…</Alert>}
                {failed && (
                  <Alert
                    tone="danger"
                    title={execution.status === "timed_out" ? "The workflow didn't report back" : "The run failed"}
                    action={
                      canWrite && (
                        <Button size="sm" variant="outline" onClick={retry} loading={retrying}>
                          <RotateCcw /> Retry
                        </Button>
                      )
                    }
                  >
                    <p>{execution.error_message ?? "Unknown error."}</p>
                    {execution.error_code && ERROR_HELP[execution.error_code] && <p className="mt-1">{ERROR_HELP[execution.error_code]}</p>}
                    {execution.error_code && <p className="mt-1 font-mono text-xs">{execution.error_code}</p>}
                  </Alert>
                )}
                {execution.status === "cancelled" && <Alert tone="info">This run was dismissed during review.</Alert>}
              </CardContent>
            </Card>
          )}

          {execution && execution.result !== null && execution.result !== undefined && !isActive && (
            <Result execution={execution} currency={currency} canWrite={canWrite} onChange={(e) => select(e)} />
          )}
          {execution && isActive && (
            <div className="space-y-3" aria-hidden>
              <Skeleton className="h-24" />
              <Skeleton className="h-64" />
            </div>
          )}
        </div>
      </div>

      {Extras && <Extras canWrite={canWrite} currency={currency} />}

      <Card>
        <CardHeader>
          <CardTitle>Execution history</CardTitle>
          <CardDescription>Recent runs of this agent. Open one to see its results.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Status</TH>
                  <TH>Input</TH>
                  <TH>Trigger</TH>
                  <TH>Started</TH>
                  <TH>Duration</TH>
                  <TH className="sr-only">Open</TH>
                </TR>
              </THead>
              <TBody>
                {history.map((h) => (
                  <TR key={h.id} className={cn("cursor-pointer", execution?.id === h.id && "bg-primary-soft/60")} onClick={() => open(h.id)}>
                    <TD>
                      <ExecutionStatusBadge status={h.status} />
                    </TD>
                    <TD className="max-w-[320px] truncate">{summarizeInput(h)}</TD>
                    <TD className="capitalize text-muted-foreground">{h.trigger.replace("_", " ")}</TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{timeAgo(h.created_at)}</TD>
                    <TD className="whitespace-nowrap text-muted-foreground">{formatDuration(h.duration_ms)}</TD>
                    <TD className="text-right">{loadingId === h.id ? <Loader2 className="ml-auto size-4 animate-spin" /> : <span className="text-xs text-primary">Open</span>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
