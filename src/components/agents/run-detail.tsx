"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { AiBadge, ExecutionStatusBadge } from "@/components/status";
import { api, formatDateTime, formatDuration, newIdempotencyKey } from "@/lib/utils";
import { PANELS } from "./panel-registry";
import type { ExecutionDetail } from "./types";
import { useExecution } from "./use-execution";

export function RunDetail({ initial, canWrite, currency }: { initial: ExecutionDetail; canWrite: boolean; currency: string }) {
  const router = useRouter();
  const { execution, select, isActive } = useExecution(initial);
  const [retrying, setRetrying] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  if (!execution) return null;
  const Result = PANELS[execution.agent_slug].ResultView;

  async function retry() {
    setRetrying(true);
    try {
      const { execution: e } = await api<{ execution: ExecutionDetail }>(`/api/executions/${execution!.id}/retry`, {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      toast("Retry started", "info");
      router.push(`/runs/${e.id}`);
    } catch (err) {
      toast((err as Error).message, "danger");
      setRetrying(false);
    }
  }

  const rows: [string, React.ReactNode][] = [
    ["Status", <span key="s" className="flex flex-wrap gap-1"><ExecutionStatusBadge status={execution.status} /><AiBadge status={execution.ai_status} /></span>],
    ["Trigger", <span key="t" className="capitalize">{execution.trigger.replace("_", " ")}</span>],
    ["Attempt", execution.attempt],
    ["Created", formatDateTime(execution.created_at)],
    ["Completed", formatDateTime(execution.completed_at)],
    ["Duration", formatDuration(execution.duration_ms)],
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Run</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {execution.retry_of && (
              <p className="mt-3 text-xs text-muted-foreground">
                Retry of{" "}
                <Link className="text-primary hover:underline" href={`/runs/${execution.retry_of}`}>
                  {execution.retry_of.slice(0, 8)}
                </Link>
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/agents/${execution.agent_slug}?run=${execution.id}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                Open in agent
              </Link>
              {canWrite && ["failed", "timed_out"].includes(execution.status) && (
                <Button size="sm" onClick={retry} loading={retrying}>
                  <RotateCcw /> Retry
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Input</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(execution.input_summary, null, 2)}</pre>
            <p className="mt-2 text-xs text-muted-foreground">Metadata only. Uploaded files are kept in private storage.</p>
          </CardContent>
        </Card>
      </div>

      {isActive && <Alert tone="info">This run is still in progress. This page updates automatically.</Alert>}
      {execution.error_message && (
        <Alert tone="danger" title={execution.error_code ?? "Error"}>
          {execution.error_message}
        </Alert>
      )}

      {execution.result !== null && execution.result !== undefined && !isActive && (
        <>
          <Result execution={execution} currency={currency} canWrite={canWrite} onChange={select} />
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Hide" : "Show"} raw result JSON
            </Button>
            {showRaw && <pre className="mt-2 max-h-[480px] overflow-auto rounded-md border bg-card p-3 text-xs">{JSON.stringify(execution.result, null, 2)}</pre>}
          </div>
        </>
      )}
    </div>
  );
}
