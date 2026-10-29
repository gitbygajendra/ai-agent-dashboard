"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Target, UserPlus, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Select, StatCard, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { AiBadge } from "@/components/status";
import { BarListChart } from "@/components/charts";
import type { LeadResult, Prospect } from "@/lib/agents/logic/leads";
import { api, cn, formatDateTime, formatNumber } from "@/lib/utils";
import { startRun } from "../run-request";
import type { ExecutionDetail, InputPanelProps, ResultViewProps } from "../types";
import { ConfirmDialog, errorMessage, FILE_ACCEPT_TABULAR, FileInput, FormErrorAlert, type FormError, isTabularFile, RunGate, SourceBadge, toFormError, useIntegration } from "./shared";

const COMPLIANCE =
  "Only contact people you have a lawful basis to contact (consent or legitimate interest under laws such as GDPR, CAN-SPAM or India's DPDP Act), and always respect opt-outs.";

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export function LeadsInputPanel({ canWrite, blockedReason, onStarted }: InputPanelProps) {
  const provider = useIntegration("lead_provider");
  const formRef = React.useRef<HTMLFormElement>(null);
  const [minScore, setMinScore] = React.useState("60");
  const [hasFile, setHasFile] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);
  const disabled = !canWrite || Boolean(blockedReason) || submitting;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return setError({ message: "Choose a prospect file (.csv or .xlsx).", issues: [] });
    if (!isTabularFile(file)) return setError({ message: "The prospect list must be a .csv or .xlsx file.", issues: [] });
    const score = Number(minScore);
    if (!Number.isInteger(score) || score < 0 || score > 100) return setError({ message: "Minimum score must be a whole number from 0 to 100.", issues: [] });
    form.set("min_score", String(score));
    for (const key of ["industries", "locations", "company_sizes", "keywords", "offering"]) {
      const v = form.get(key);
      if (typeof v === "string") form.set(key, v.trim());
    }
    setSubmitting(true);
    try {
      const execution = await startRun("lead-generation-agent", form);
      onStarted(execution);
      formRef.current?.reset();
      setHasFile(false);
      setMinScore("60");
    } catch (err) {
      setError(toFormError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-4" noValidate>
      <RunGate blockedReason={blockedReason} canWrite={canWrite} />

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">Prospect source</legend>
        <label className="flex items-start gap-2.5 rounded-lg border p-3 text-sm">
          <input type="radio" checked readOnly className="mt-0.5 accent-[var(--primary)]" />
          <span>
            <span className="font-medium">Upload a prospect list</span>
            <span className="block text-xs text-muted-foreground">CSV or Excel with name, email, company, title, industry, location, company size and an optional consent / opt-out column.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 rounded-lg border border-dashed p-3 text-sm opacity-70">
          <input type="radio" disabled className="mt-0.5" />
          <span>
            <span className="font-medium">Search a data provider</span>
            <span className="block text-xs text-muted-foreground">
              {provider.loading
                ? "Checking provider connection…"
                : provider.connected
                  ? "A provider is connected, but live provider search isn't implemented yet. Export a list from the provider and upload it here."
                  : (
                      <>
                        No authorized data provider is connected. See <Link href="/integrations" className="text-primary underline">Integrations</Link>.
                      </>
                    )}
            </span>
          </span>
        </label>
      </fieldset>

      <Field label="Prospect file (required)">
        <FileInput name="file" accept={FILE_ACCEPT_TABULAR} disabled={!canWrite} onChange={(e) => setHasFile(Boolean(e.target.files?.length))} />
      </Field>

      <div className="space-y-3">
        <p className="text-sm font-medium">Ideal customer profile</p>
        <p className="-mt-2 text-xs text-muted-foreground">Comma-separated. Leave blank to score on contactability only.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Industries">
            <Input name="industries" maxLength={1000} placeholder="corporate gifting, events" />
          </Field>
          <Field label="Locations">
            <Input name="locations" maxLength={1000} placeholder="Delhi, Gurugram, Noida" />
          </Field>
          <Field label="Company sizes">
            <Input name="company_sizes" maxLength={1000} placeholder="11-50, 51-200" />
          </Field>
          <Field label="Keywords">
            <Input name="keywords" maxLength={1000} placeholder="hampers, B2B" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Min. score">
            <Input type="number" min={0} max={100} step={1} value={minScore} onChange={(e) => setMinScore(e.target.value)} />
          </Field>
          <Field label="Your offering (one line)" hint="Used in outreach drafts.">
            <Input name="offering" maxLength={300} placeholder="custom corporate gift boxes for festive seasons" />
          </Field>
        </div>
      </div>

      <Alert tone="info" title="Compliance">
        {COMPLIANCE} Nothing is sent or added to the CRM until you approve it.
      </Alert>
      <FormErrorAlert error={error} />
      <Button type="submit" disabled={disabled || !hasFile} loading={submitting}>
        <Target /> Score prospects
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

type LeadApproval = { imported: number; skipped: number; approved_by?: string; at?: string };
type LeadResultWithApproval = LeadResult & { approval?: LeadApproval };

const STATUS_BADGE: Record<Prospect["status"], { label: string; tone: "success" | "neutral" | "warning" | "danger" }> = {
  new: { label: "New", tone: "success" },
  duplicate_in_crm: { label: "Already in CRM", tone: "neutral" },
  duplicate_in_file: { label: "Duplicate in file", tone: "warning" },
  opted_out: { label: "Opted out", tone: "danger" },
};

export function LeadsResultView(props: ResultViewProps) {
  const result = props.execution.result as LeadResultWithApproval | null;
  if (!result || !Array.isArray(result.prospects)) {
    return <EmptyState icon={Target} title="No prospects" description="This run didn't return a scored list." />;
  }
  return <LeadsResultInner key={props.execution.id} {...props} result={result} />;
}

function LeadsResultInner({ execution, canWrite, onChange, result }: ResultViewProps & { result: LeadResultWithApproval }) {
  const awaiting = execution.status === "awaiting_approval";
  const actionable = awaiting && canWrite;
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(result.prospects.filter((p) => p.qualified && p.status === "new").map((p) => p.id)));
  const [sortDir, setSortDir] = React.useState<"desc" | "asc">("desc");
  const [filter, setFilter] = React.useState<"all" | "qualified" | "new" | "excluded">("all");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [limit, setLimit] = React.useState(50);
  const [confirm, setConfirm] = React.useState<"import" | "dismiss" | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const excludedTotal = Object.values(result.excluded ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const visible = result.prospects
    .filter((p) => (filter === "qualified" ? p.qualified : filter === "new" ? p.status === "new" : filter === "excluded" ? p.status !== "new" : true))
    .sort((a, b) => (sortDir === "desc" ? b.score - a.score : a.score - b.score));
  const importable = result.prospects.filter((p) => p.status === "new");
  const chosen = importable.filter((p) => selected.has(p.id)).map((p) => p.id);

  function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function post(body: Record<string, unknown>): Promise<ExecutionDetail | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ execution: ExecutionDetail | null }>(`/api/executions/${execution.id}/approve`, { method: "POST", json: body });
      if (res.execution) onChange(res.execution);
      return res.execution;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function importSelected() {
    const updated = await post({ prospect_ids: chosen.slice(0, 1000) });
    const approval = (updated?.result as LeadResultWithApproval | null)?.approval;
    if (approval) toast(`${approval.imported} added to the CRM${approval.skipped ? `, ${approval.skipped} skipped (already there)` : ""}.`, "success");
  }

  async function dismiss() {
    const updated = await post({ reject: true });
    if (updated) toast("Run dismissed. Nothing was added to the CRM.");
  }

  const segments = [
    { title: "By industry", data: result.segments?.by_industry ?? [] },
    { title: "By location", data: result.segments?.by_location ?? [] },
    { title: "By company size", data: result.segments?.by_size ?? [] },
  ];

  return (
    <div className="space-y-5">
      <Alert tone="info" title="Compliance">
        {result.compliance_note || COMPLIANCE}
      </Alert>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Rows in file" value={formatNumber(result.total_rows)} />
        <StatCard label="Qualified" value={formatNumber(result.qualified_count)} tone="success" hint={`Score ≥ ${result.criteria?.min_score ?? 60}`} />
        <StatCard
          label="Excluded"
          value={formatNumber(excludedTotal)}
          hint={[
            result.excluded?.duplicate_in_crm ? `${result.excluded.duplicate_in_crm} in CRM` : null,
            result.excluded?.duplicate_in_file ? `${result.excluded.duplicate_in_file} duplicate` : null,
            result.excluded?.opted_out ? `${result.excluded.opted_out} opted out` : null,
            result.excluded?.invalid ? `${result.excluded.invalid} invalid` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined}
        />
        <StatCard label="Outreach drafts" value={formatNumber(result.prospects.filter((p) => p.outreach_draft).length)} />
      </div>

      {result.approval && (
        <Alert tone="success" title="Added to CRM">
          {result.approval.imported} prospect{result.approval.imported === 1 ? "" : "s"} imported
          {result.approval.skipped ? `, ${result.approval.skipped} skipped because they already exist` : ""}
          {result.approval.at ? ` · ${formatDateTime(result.approval.at)}` : ""}. <Link href="/crm">Open CRM</Link>
        </Alert>
      )}
      {execution.status === "cancelled" && <Alert tone="info">This run was dismissed. Nothing was added to the CRM.</Alert>}
      {awaiting && !canWrite && <Alert tone="info">Waiting for a member or admin to review and import.</Alert>}
      {error && <Alert tone="danger" title="Action failed">{error}</Alert>}

      <div className="grid gap-5 lg:grid-cols-3">
        {segments.map((s) => (
          <Card key={s.title}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
            </CardHeader>
            <CardContent>
              {s.data.length ? (
                <BarListChart data={s.data} nameKey="name" valueKey="count" label={`New prospects ${s.title.toLowerCase()}`} />
              ) : (
                <p className="text-sm text-muted-foreground">No new prospects.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Prospects</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {result.prospects.some((p) => p.outreach_draft) && <SourceBadge ai={Boolean(result.ai_generated)} />}
              <AiBadge status={execution.ai_status} />
              <Select aria-label="Filter prospects" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-8 w-auto text-xs">
                <option value="all">All ({result.prospects.length})</option>
                <option value="qualified">Qualified ({result.qualified_count})</option>
                <option value="new">New ({importable.length})</option>
                <option value="excluded">Excluded ({result.prospects.length - importable.length})</option>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Scores and reasons are computed from your criteria. {result.ai_generated ? "Outreach drafts were personalized by AI — review before using." : "Outreach drafts are templates."}</p>
        </CardHeader>

        {actionable && (
          <div className="mx-5 mb-3 flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={importable.length > 0 && chosen.length === importable.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(importable.map((p) => p.id)) : new Set())}
              />
              {chosen.length} of {importable.length} new prospect{importable.length === 1 ? "" : "s"} selected
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConfirm("import")} disabled={!chosen.length || busy}>
                <UserPlus /> Add {chosen.length} to CRM
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm("dismiss")} disabled={busy}>
                <X /> Dismiss
              </Button>
            </div>
          </div>
        )}

        <CardContent className="px-0 pb-2">
          {visible.length === 0 ? (
            <p className="px-5 pb-3 text-sm text-muted-foreground">No prospects match this filter.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  {actionable && <TH className="w-8" aria-label="Select" />}
                  <TH className="w-8" aria-label="Expand" />
                  <TH>Prospect</TH>
                  <TH>Company</TH>
                  <TH className="hidden md:table-cell">Segment</TH>
                  <TH>
                    <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))} aria-label={`Sort by score ${sortDir === "desc" ? "ascending" : "descending"}`}>
                      Score {sortDir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
                    </button>
                  </TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {visible.slice(0, limit).map((p) => {
                  const open = expanded.has(p.id);
                  const cols = actionable ? 7 : 6;
                  return (
                    <React.Fragment key={p.id}>
                      <TR className={cn(open && "border-b-0 bg-muted/30")}>
                        {actionable && (
                          <TD>
                            <input
                              type="checkbox"
                              className="size-4 accent-[var(--primary)]"
                              checked={selected.has(p.id)}
                              disabled={p.status !== "new"}
                              onChange={() => toggle(setSelected, p.id)}
                              aria-label={`Select ${p.name}`}
                            />
                          </TD>
                        )}
                        <TD>
                          <button type="button" onClick={() => toggle(setExpanded, p.id)} className="rounded p-0.5 text-muted-foreground hover:bg-muted" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${p.name}`}>
                            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </TD>
                        <TD className="min-w-40">
                          <p className="font-medium">{p.name}</p>
                          <p className="text-xs text-muted-foreground">{[p.title, p.email].filter(Boolean).join(" · ") || "No email"}</p>
                        </TD>
                        <TD>{p.company ?? "—"}</TD>
                        <TD className="hidden text-xs text-muted-foreground md:table-cell">{[p.industry, p.location, p.company_size].filter(Boolean).join(" · ") || "—"}</TD>
                        <TD>
                          <span className={cn("font-semibold tabular-nums", p.qualified ? "text-success" : "text-muted-foreground")}>{p.score}</span>
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={STATUS_BADGE[p.status]?.tone ?? "neutral"}>{STATUS_BADGE[p.status]?.label ?? p.status}</Badge>
                            {p.qualified && <Badge tone="primary">Qualified</Badge>}
                          </div>
                        </TD>
                      </TR>
                      {open && (
                        <tr className="border-b bg-muted/30">
                          <td colSpan={cols} className="px-3 pb-4 pt-1">
                            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                              <div className="space-y-1 text-sm">
                                <p className="text-xs font-medium text-muted-foreground">Why this score · source row {p.row}</p>
                                {p.reasons.length ? (
                                  <ul className="list-disc space-y-0.5 pl-5">
                                    {p.reasons.map((r, i) => (
                                      <li key={i}>{r}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-muted-foreground">No criteria matched.</p>
                                )}
                                {(p.phone || p.website) && <p className="pt-1 text-xs text-muted-foreground">{[p.phone, p.website].filter(Boolean).join(" · ")}</p>}
                              </div>
                              <div className="space-y-1">
                                <p className="text-xs font-medium text-muted-foreground">Outreach draft</p>
                                {p.outreach_draft ? (
                                  <div className="rounded-md border bg-card p-3 text-sm">
                                    <p className="font-medium">{p.outreach_draft.subject}</p>
                                    <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{p.outreach_draft.body}</p>
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted-foreground">{p.qualified ? "No email address, so no draft." : "Drafts are only written for qualified prospects."}</p>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </TBody>
            </Table>
          )}
          {visible.length > limit && (
            <div className="px-5 py-3">
              <Button size="sm" variant="outline" onClick={() => setLimit((l) => l + 100)}>
                Show more ({visible.length - limit} remaining)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === "import"}
        onClose={() => setConfirm(null)}
        onConfirm={importSelected}
        busy={busy}
        title={`Add ${chosen.length} prospect${chosen.length === 1 ? "" : "s"} to the CRM?`}
        confirmLabel={`Add ${chosen.length} to CRM`}
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>They&apos;ll be created as leads with their score, industry, location and company size. Anyone already in the CRM (same email) is skipped.</p>
          <p>No emails are sent. Confirm you have a lawful basis to contact these people.</p>
          {chosen.length > 1000 && <p className="text-warning">Only the first 1,000 selected prospects can be imported in one go.</p>}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "dismiss"}
        onClose={() => setConfirm(null)}
        onConfirm={dismiss}
        busy={busy}
        tone="danger"
        title="Dismiss this run?"
        description="Nothing will be added to the CRM. You can run the agent again later."
        confirmLabel="Dismiss"
      />
    </div>
  );
}
