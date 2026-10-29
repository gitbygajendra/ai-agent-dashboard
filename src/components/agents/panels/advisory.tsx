"use client";

import * as React from "react";
import { CheckCircle2, Lightbulb, RefreshCw, Send, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Select, Skeleton, Spinner, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { AiBadge } from "@/components/status";
import type { AdvisoryResult, Evidence, Recommendation } from "@/lib/agents/logic/advisory";
import { api, cn, timeAgo } from "@/lib/utils";
import { startRun } from "../run-request";
import type { InputPanelProps, ResultViewProps } from "../types";
import { errorMessage, FormErrorAlert, type FormError, RunGate, SectionTitle, SourceBadge, toFormError, useApi } from "./shared";

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

const EXAMPLES = [
  "My sales are declining. Recommend three actions to improve conversions.",
  "Which lead sources bring the most customers, and where should I focus?",
  "Where can I cut costs without slowing growth?",
];

export function AdvisoryInputPanel({ canWrite, blockedReason, onStarted }: InputPanelProps) {
  const [question, setQuestion] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);
  const disabled = !canWrite || Boolean(blockedReason) || submitting;
  const trimmed = question.trim();

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (disabled) return;
    if (trimmed.length < 3) return setError({ message: "Ask a question (at least 3 characters).", issues: [] });
    setError(null);
    setSubmitting(true);
    try {
      const execution = await startRun("data-advisory-agent", { question: trimmed });
      onStarted(execution);
      setQuestion("");
    } catch (err) {
      setError(toFormError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <RunGate blockedReason={blockedReason} canWrite={canWrite} />
      <div className="rounded-lg border bg-card focus-within:outline-2 focus-within:outline-ring">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          maxLength={1000}
          rows={3}
          placeholder="Ask a question about your business…"
          aria-label="Your question"
          className="block w-full resize-none rounded-t-lg bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/70"
          disabled={!canWrite}
        />
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <span className="pl-1 text-xs text-muted-foreground tabular-nums">{question.length}/1000</span>
          <Button type="submit" size="sm" disabled={disabled || trimmed.length < 3} loading={submitting}>
            <Send /> Ask
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setQuestion(ex)}
            disabled={!canWrite}
            className="rounded-full border bg-card px-3 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {ex}
          </button>
        ))}
      </div>
      <FormErrorAlert error={error} />
      <p className="text-xs text-muted-foreground">Uses your CRM, analytics and finance records. Recommendations cite the figures they rely on.</p>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Saved recommendations                                               */
/* ------------------------------------------------------------------ */

type RecStatus = "pending" | "accepted" | "completed" | "dismissed";
const STATUSES: RecStatus[] = ["pending", "accepted", "completed", "dismissed"];
const STATUS_LABEL: Record<RecStatus, string> = { pending: "Pending", accepted: "Accepted", completed: "Completed", dismissed: "Dismissed" };
const STATUS_TONE = { pending: "neutral", accepted: "primary", completed: "success", dismissed: "outline" } as const;
const CONFIDENCE_TONE = { high: "success", medium: "warning", low: "neutral" } as const;

type SavedRec = {
  id: string;
  execution_id: string | null;
  key: string | null;
  title: string;
  rationale: string | null;
  actions: unknown;
  evidence: unknown;
  assumptions: unknown;
  risks: unknown;
  confidence: "low" | "medium" | "high" | null;
  status: RecStatus;
  created_at: string;
  updated_at: string;
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function evidenceList(v: unknown): Evidence[] {
  return Array.isArray(v)
    ? v.filter((x): x is Evidence => Boolean(x) && typeof x === "object" && typeof (x as Evidence).metric === "string").map((x) => ({ metric: x.metric, value: String(x.value ?? ""), source: String(x.source ?? "") }))
    : [];
}

function useRecStatusUpdater(mutate: (fn: (prev: { recommendations: SavedRec[] } | null) => { recommendations: SavedRec[] } | null) => void) {
  const [saving, setSaving] = React.useState<string | null>(null);
  const update = React.useCallback(
    async (id: string, status: RecStatus, previous: RecStatus) => {
      const apply = (s: RecStatus) => mutate((prev) => (prev ? { recommendations: prev.recommendations.map((r) => (r.id === id ? { ...r, status: s } : r)) } : prev));
      apply(status);
      setSaving(id);
      try {
        await api(`/api/recommendations/${id}`, { method: "PATCH", json: { status } });
      } catch (err) {
        apply(previous);
        toast(errorMessage(err, "Could not update the recommendation."), "danger");
      } finally {
        setSaving(null);
      }
    },
    [mutate],
  );
  return { saving, update };
}

function StatusSelect({ value, onChange, disabled, saving }: { value: RecStatus; onChange: (s: RecStatus) => void; disabled: boolean; saving: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {saving && <Spinner className="size-3.5" />}
      <Select aria-label="Recommendation status" value={value} onChange={(e) => onChange(e.target.value as RecStatus)} disabled={disabled || saving} className="h-8 w-auto text-xs">
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
    </div>
  );
}

function EvidenceTable({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return null;
  return (
    <div className="rounded-md border">
      <Table>
        <THead>
          <TR>
            <TH>Metric</TH>
            <TH className="text-right">Value</TH>
            <TH>Source</TH>
          </TR>
        </THead>
        <TBody>
          {evidence.map((e, i) => (
            <TR key={`${e.metric}-${i}`}>
              <TD>{e.metric}</TD>
              <TD className="text-right tabular-nums whitespace-nowrap">{e.value}</TD>
              <TD className="text-xs text-muted-foreground">{e.source}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function BulletList({ title, items, tone }: { title: string; items: string[]; tone?: "warning" }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={cn("mb-1 text-xs font-medium", tone === "warning" ? "text-warning" : "text-muted-foreground")}>{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export function AdvisoryResultView(props: ResultViewProps) {
  const result = props.execution.result as AdvisoryResult | null;
  if (!result || !Array.isArray(result.recommendations)) {
    return <EmptyState icon={Lightbulb} title="No recommendations" description="This run didn't return any advice." />;
  }
  return <AdvisoryResultInner key={props.execution.id} {...props} result={result} />;
}

function AdvisoryResultInner({ execution, canWrite, result }: ResultViewProps & { result: AdvisoryResult }) {
  const saved = useApi<{ recommendations: SavedRec[] }>(`/api/recommendations?execution_id=${encodeURIComponent(execution.id)}`, execution.status);
  const { saving, update } = useRecStatusUpdater(saved.mutate);
  const byKey = new Map((saved.data?.recommendations ?? []).map((r) => [r.key ?? r.title, r]));
  const recs = [...result.recommendations].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Question</p>
        <p className="text-base font-medium">{result.question}</p>
      </div>

      {result.insufficient_data && (
        <Alert tone="warning" title="Not enough data for confident recommendations">
          {result.missing_data?.length ? `Missing: ${result.missing_data.join(", ")}. ` : ""}
          Add CRM records, run the Data Analytics or Finance agent, then ask again.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Summary</CardTitle>
            <span className="flex flex-wrap gap-2">
              <SourceBadge ai={result.narrative_source === "ai"} />
              <AiBadge status={execution.ai_status} />
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{result.narrative || "—"}</p>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Data coverage</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {(result.data_coverage ?? []).map((c) => (
                <li key={c.source} className="flex gap-2.5 text-sm">
                  {c.available ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Available" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Missing" />}
                  <span>
                    <span className="font-medium">{c.source}</span>
                    {c.note && <span className="text-muted-foreground"> — {c.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Verified metrics</CardTitle>
              <SourceBadge ai={false} />
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            {result.verified_metrics?.length ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Metric</TH>
                    <TH className="text-right">Value</TH>
                    <TH>Source</TH>
                  </TR>
                </THead>
                <TBody>
                  {result.verified_metrics.map((m, i) => (
                    <TR key={`${m.metric}-${i}`}>
                      <TD>{m.metric}</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{m.value}</TD>
                      <TD className="text-xs text-muted-foreground">{m.source}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="px-5 pb-3 text-sm text-muted-foreground">No metrics were available.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <SectionTitle
          aside={
            saved.error ? (
              <span className="flex items-center gap-2 text-xs text-danger">
                {saved.error}
                <Button size="sm" variant="ghost" onClick={saved.reload}>
                  <RefreshCw /> Retry
                </Button>
              </span>
            ) : saved.loading && !saved.data ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Loading status…
              </span>
            ) : null
          }
        >
          Recommendations ({recs.length})
        </SectionTitle>
        {recs.length === 0 && (
          <EmptyState icon={Lightbulb} title="No recommendations" description="There wasn't enough evidence in your records to recommend specific actions." />
        )}
        {recs.map((rec) => (
          <RecommendationCard
            key={rec.key}
            rec={rec}
            saved={byKey.get(rec.key) ?? byKey.get(String(rec.title).slice(0, 300)) ?? null}
            canWrite={canWrite}
            saving={saving}
            onStatus={update}
            savedLoaded={Boolean(saved.data)}
          />
        ))}
      </div>
    </div>
  );
}

function RecommendationCard({
  rec,
  saved,
  canWrite,
  saving,
  onStatus,
  savedLoaded,
}: {
  rec: Recommendation;
  saved: SavedRec | null;
  canWrite: boolean;
  saving: string | null;
  onStatus: (id: string, s: RecStatus, prev: RecStatus) => void;
  savedLoaded: boolean;
}) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 flex-1 leading-snug">{rec.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={CONFIDENCE_TONE[rec.confidence] ?? "neutral"}>{rec.confidence} confidence</Badge>
            {saved ? (
              <StatusSelect value={saved.status} onChange={(s) => onStatus(saved.id, s, saved.status)} disabled={!canWrite} saving={saving === saved.id} />
            ) : savedLoaded ? (
              <span className="text-xs text-muted-foreground">Not saved yet</span>
            ) : null}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{rec.rationale}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <BulletList title="Actions" items={strings(rec.actions)} />
        <EvidenceTable evidence={evidenceList(rec.evidence)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <BulletList title="Assumptions" items={strings(rec.assumptions)} />
          <BulletList title="Risks" items={strings(rec.risks)} tone="warning" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Extras: all saved recommendations                                   */
/* ------------------------------------------------------------------ */

export function AdvisoryExtras({ canWrite }: { canWrite: boolean; currency: string }) {
  const { data, error, loading, reload, mutate } = useApi<{ recommendations: SavedRec[] }>("/api/recommendations");
  const { saving, update } = useRecStatusUpdater(mutate);
  const all = data?.recommendations ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>Saved recommendations</CardTitle>
            <p className="text-sm text-muted-foreground">Track what you&apos;ve acted on. Showing the latest 100.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <Alert tone="danger" title="Couldn't load recommendations" action={<Button size="sm" variant="outline" onClick={reload}>Retry</Button>}>
            {error}
          </Alert>
        )}
        {loading && !data && (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        )}
        {data && all.length === 0 && <EmptyState icon={Lightbulb} title="No recommendations yet" description="Ask the advisory agent a question to get evidence-backed recommendations." />}
        {STATUSES.map((status) => {
          const group = all.filter((r) => r.status === status);
          if (!group.length) return null;
          return (
            <section key={status} className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
                <span className="text-xs text-muted-foreground tabular-nums">{group.length}</span>
              </div>
              <ul className="divide-y rounded-lg border">
                {group.map((r) => (
                  <li key={r.id} className="p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <details className="min-w-0 flex-1">
                        <summary className="cursor-pointer text-sm font-medium">
                          {r.title}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">{timeAgo(r.created_at)}</span>
                        </summary>
                        <div className="mt-2 space-y-3">
                          {r.rationale && <p className="text-sm text-muted-foreground">{r.rationale}</p>}
                          <BulletList title="Actions" items={strings(r.actions)} />
                          <EvidenceTable evidence={evidenceList(r.evidence)} />
                          <BulletList title="Risks" items={strings(r.risks)} tone="warning" />
                        </div>
                      </details>
                      <div className="flex items-center gap-2">
                        {r.confidence && <Badge tone={CONFIDENCE_TONE[r.confidence]}>{r.confidence}</Badge>}
                        <StatusSelect value={r.status} onChange={(s) => update(r.id, s, r.status)} disabled={!canWrite} saving={saving === r.id} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

