"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy, Inbox, Mail, Plus, Send, Trash2, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Select, Spinner, StatCard, Textarea } from "@/components/ui";
import { Tabs, toast } from "@/components/ui/client";
import { AiBadge } from "@/components/status";
import type { EmailResult, ProcessedEmail } from "@/lib/agents/logic/email";
import { api, cn, formatDateTime } from "@/lib/utils";
import { startRun } from "../run-request";
import type { ExecutionDetail, InputPanelProps, ResultViewProps } from "../types";
import {
  ChipList,
  ConfirmDialog,
  EMAIL_RE,
  FormErrorAlert,
  type FormError,
  humanize,
  RunGate,
  SourceBadge,
  toFormError,
  useIntegration,
  errorMessage,
} from "./shared";

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

type Tone = "friendly" | "formal" | "concise";
type PastedRow = { key: string; from: string; subject: string; body: string };
const DEFAULT_QUERY = "in:inbox newer_than:7d -category:promotions -from:me";
const MAX_PASTED = 20;

export function EmailInputPanel(props: InputPanelProps) {
  const { canWrite, blockedReason, onStarted } = props;
  const gmail = useIntegration("gmail");
  const [mode, setMode] = React.useState<"pasted" | "inbox">("pasted");
  const seq = React.useRef(1);
  const [rows, setRows] = React.useState<PastedRow[]>([{ key: "r1", from: "", subject: "", body: "" }]);
  const [query, setQuery] = React.useState(DEFAULT_QUERY);
  const [max, setMax] = React.useState("15");
  const [tone, setTone] = React.useState<Tone>("friendly");
  const [instructions, setInstructions] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);

  const inboxUnavailable = mode === "inbox" && !gmail.connected;
  const disabled = !canWrite || Boolean(blockedReason) || submitting || inboxUnavailable || (mode === "inbox" && gmail.loading);

  function updateRow(key: string, patch: Partial<PastedRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    seq.current += 1;
    const key = `r${seq.current}`;
    setRows((prev) => (prev.length >= MAX_PASTED ? prev : [...prev, { key, from: "", subject: "", body: "" }]));
  }
  function removeRow(key: string) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    let body: Record<string, unknown>;
    if (mode === "pasted") {
      const filled = rows.filter((r) => r.body.trim() || r.subject.trim() || r.from.trim());
      const missing = filled.findIndex((r) => !r.body.trim());
      if (!filled.length) return setError({ message: "Paste at least one email.", issues: [] });
      if (missing >= 0) return setError({ message: `Email ${rows.indexOf(filled[missing]) + 1} has no body. Paste the email text.`, issues: [] });
      body = {
        mode: "pasted",
        emails: filled.map((r) => ({ from: r.from.trim(), subject: r.subject.trim(), body: r.body.trim() })),
        instructions: instructions.trim() || null,
        tone,
      };
    } else {
      const n = Math.round(Number(max));
      if (!Number.isFinite(n) || n < 1 || n > 25) return setError({ message: "Choose between 1 and 25 emails.", issues: [] });
      body = { mode: "inbox", query: query.trim() || DEFAULT_QUERY, max: n, instructions: instructions.trim() || null, tone };
    }
    setSubmitting(true);
    try {
      const execution = await startRun("email-automation-agent", body);
      onStarted(execution);
      if (mode === "pasted") {
        seq.current += 1;
        setRows([{ key: `r${seq.current}`, from: "", subject: "", body: "" }]);
      }
    } catch (err) {
      setError(toFormError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <RunGate blockedReason={blockedReason} canWrite={canWrite} />
      <Tabs
        value={mode}
        onChange={(v) => {
          setMode(v);
          setError(null);
        }}
        tabs={[
          { value: "pasted", label: "Paste emails" },
          {
            value: "inbox",
            label: (
              <span className="inline-flex items-center gap-1.5">
                From Gmail inbox
                {!gmail.loading && !gmail.connected && <span className="text-xs text-muted-foreground">(not connected)</span>}
              </span>
            ),
          },
        ]}
      />

      {mode === "pasted" ? (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <fieldset key={r.key} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <legend className="text-xs font-medium text-muted-foreground">Email {i + 1}</legend>
                {rows.length > 1 && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeRow(r.key)} aria-label={`Remove email ${i + 1}`}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input placeholder="From (e.g. Priya <priya@acme.com>)" value={r.from} maxLength={320} onChange={(e) => updateRow(r.key, { from: e.target.value })} aria-label={`Email ${i + 1} sender`} />
                <Input placeholder="Subject" value={r.subject} maxLength={500} onChange={(e) => updateRow(r.key, { subject: e.target.value })} aria-label={`Email ${i + 1} subject`} />
              </div>
              <Textarea placeholder="Paste the email body" rows={4} value={r.body} maxLength={20000} onChange={(e) => updateRow(r.key, { body: e.target.value })} aria-label={`Email ${i + 1} body`} />
            </fieldset>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={rows.length >= MAX_PASTED}>
            <Plus /> Add another email
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {gmail.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Checking Gmail connection…
            </div>
          ) : !gmail.connected ? (
            <Alert tone="warning" title="Gmail isn't connected">
              {gmail.error ? `${gmail.error} ` : gmail.info?.detail ? `${gmail.info.detail} ` : ""}
              Connect Gmail on the <Link href="/integrations">Integrations</Link> page to process your inbox. You can still paste emails.
            </Alert>
          ) : (
            <p className="text-xs text-muted-foreground">
              Reading from {gmail.info?.account ?? "your connected Gmail account"}. Nothing is sent without your approval.
            </p>
          )}
          <Field label="Gmail search" hint="Uses Gmail search syntax.">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={300} disabled={!gmail.connected} />
          </Field>
          <Field label="Max emails" hint="1–25">
            <Input type="number" min={1} max={25} value={max} onChange={(e) => setMax(e.target.value)} disabled={!gmail.connected} className="w-28" />
          </Field>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Reply tone">
          <Select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
            <option value="friendly">Friendly</option>
            <option value="formal">Formal</option>
            <option value="concise">Concise</option>
          </Select>
        </Field>
        <Field label="Instructions (optional)">
          <Textarea rows={2} className="min-h-9" placeholder="e.g. Offer a call on Thursday; mention our 30-day returns." value={instructions} maxLength={2000} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
      </div>

      <FormErrorAlert error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={disabled} loading={submitting}>
          <Mail /> {mode === "pasted" ? "Process emails" : "Process inbox"}
        </Button>
        <p className="text-xs text-muted-foreground">Drafts wait for your approval. Nothing is sent automatically.</p>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

type Decision = { status: "sent" | "skipped" | "failed"; at: string; by: string; to?: string; error?: string };
type EmailResultWithApproval = EmailResult & { approval?: { decisions?: Record<string, Decision> } };
type Draft = { to: string; subject: string; body: string };
type ApproveItem = { email_id: string; action: "send" | "skip"; to?: string; subject?: string; body?: string };

const CATEGORY_LABEL: Record<string, string> = {
  customer_inquiry: "Customer inquiry",
  support: "Support",
  sales_lead: "Sales lead",
  billing: "Billing",
  scheduling: "Scheduling",
  newsletter: "Newsletter",
  internal: "Internal",
  other: "Other",
};
const PRIORITY_TONE = { high: "danger", normal: "neutral", low: "outline" } as const;

export function EmailResultView(props: ResultViewProps) {
  const result = props.execution.result as EmailResultWithApproval | null;
  if (!result || !Array.isArray(result.emails)) {
    return <EmptyState icon={Mail} title="No email results" description="This run didn't return any processed emails." />;
  }
  return <EmailResultInner key={props.execution.id} {...props} result={result} />;
}

function EmailResultInner({ execution, canWrite, onChange, result }: ResultViewProps & { result: EmailResultWithApproval }) {
  const gmail = useIntegration("gmail");
  const decisions = result.approval?.decisions ?? {};
  const awaiting = execution.status === "awaiting_approval";
  const actionable = awaiting && canWrite;
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() =>
    Object.fromEntries(result.emails.filter((e) => e.draft).map((e) => [e.id, { to: e.draft!.to ?? "", subject: e.draft!.subject, body: e.draft!.body }])),
  );
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<null | { kind: "send"; items: ApproveItem[] } | { kind: "dismiss" }>(null);
  const [error, setError] = React.useState<string | null>(null);

  const pendingIds = result.emails.filter((e) => e.draft && (!decisions[e.id] || decisions[e.id].status === "failed")).map((e) => e.id);
  const selectedPending = pendingIds.filter((id) => selected.has(id));
  const canSend = gmail.connected;

  function draftProblem(id: string): string | null {
    const d = drafts[id];
    if (!d) return "No draft.";
    if (!EMAIL_RE.test(d.to.trim())) return "Add a valid recipient address.";
    if (!d.subject.trim()) return "Add a subject.";
    if (!d.body.trim()) return "The reply is empty.";
    return null;
  }

  function sendItem(id: string): ApproveItem {
    const d = drafts[id];
    return { email_id: id, action: "send", to: d.to.trim(), subject: d.subject.trim(), body: d.body.trim() };
  }

  function requestSend(ids: string[]) {
    setError(null);
    const problems = ids.map((id) => [id, draftProblem(id)] as const).filter(([, p]) => p);
    if (problems.length) {
      const email = result.emails.find((e) => e.id === problems[0][0]);
      setError(`${email?.subject ?? "A draft"}: ${problems[0][1]}`);
      return;
    }
    setConfirm({ kind: "send", items: ids.map(sendItem) });
  }

  async function post(body: Record<string, unknown>, busyKey: string): Promise<ExecutionDetail | null> {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await api<{ execution: ExecutionDetail | null }>(`/api/executions/${execution.id}/approve`, { method: "POST", json: body });
      if (res.execution) onChange(res.execution);
      return res.execution;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function confirmSend(items: ApproveItem[]) {
    const updated = await post({ items }, "send");
    setConfirm(null);
    if (!updated) return;
    const d = (updated.result as EmailResultWithApproval | null)?.approval?.decisions ?? {};
    const sent = items.filter((i) => d[i.email_id]?.status === "sent").length;
    const failed = items.filter((i) => d[i.email_id]?.status === "failed").length;
    setSelected(new Set());
    if (failed) toast(`${sent} sent, ${failed} failed. See the errors below.`, "danger");
    else toast(`${sent} email${sent === 1 ? "" : "s"} sent.`, "success");
  }

  async function skip(ids: string[]) {
    const updated = await post({ items: ids.map((id) => ({ email_id: id, action: "skip" })) }, `skip:${ids.join(",")}`);
    if (updated) {
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      toast(ids.length === 1 ? "Draft skipped." : `${ids.length} drafts skipped.`);
    }
  }

  async function dismissAll() {
    const updated = await post({ reject: true }, "dismiss");
    setConfirm(null);
    if (updated) toast("Run dismissed. No emails were sent.");
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const categories = Object.entries(result.counts?.by_category ?? {}).sort((a, b) => b[1] - a[1]);
  const sentCount = Object.values(decisions).filter((d) => d.status === "sent").length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Emails processed" value={result.counts?.total ?? result.emails.length} />
        <StatCard label="Need a reply" value={result.counts?.needs_reply ?? 0} />
        <StatCard label="Drafts prepared" value={result.counts?.drafts ?? 0} />
        <StatCard label="Sent" value={sentCount} tone={sentCount ? "success" : "neutral"} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {categories.map(([cat, n]) => (
          <Badge key={cat} tone="outline">
            {CATEGORY_LABEL[cat] ?? humanize(cat)} <span className="tabular-nums text-muted-foreground">{n}</span>
          </Badge>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <SourceBadge ai={Boolean(result.ai_generated)} />
          <AiBadge status={execution.ai_status} />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Categories, priorities and extracted details are computed by rules. {result.ai_generated ? "Summaries, action items and reply drafts were written by AI — review before sending." : "Summaries and drafts are template-based; fill in the [placeholders] before sending."}
      </p>

      {awaiting && !canWrite && <Alert tone="info">These drafts are waiting for approval by a member or admin.</Alert>}
      {actionable && !gmail.loading && !canSend && (
        <Alert tone="warning" title="Gmail isn't connected, so drafts can't be sent from here">
          Copy a draft into your email client, then mark it as skipped. To send directly, connect Gmail on the <Link href="/integrations">Integrations</Link> page.
        </Alert>
      )}
      {execution.status === "cancelled" && <Alert tone="info">This run was dismissed. No emails were sent.</Alert>}
      {error && <Alert tone="danger" title="Action failed">{error}</Alert>}

      {actionable && pendingIds.length > 0 && (
        <Card className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={selectedPending.length === pendingIds.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(pendingIds) : new Set())}
            />
            {selectedPending.length ? `${selectedPending.length} of ${pendingIds.length} selected` : `Select all ${pendingIds.length} pending draft${pendingIds.length === 1 ? "" : "s"}`}
          </label>
          <div className="flex flex-wrap gap-2">
            {canSend && (
              <Button size="sm" onClick={() => requestSend(selectedPending)} disabled={!selectedPending.length || busy !== null}>
                <Send /> Send selected
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => skip(selectedPending)} disabled={!selectedPending.length || busy !== null} loading={busy?.startsWith("skip:") && selectedPending.length > 1}>
              Skip selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: "dismiss" })} disabled={busy !== null}>
              <X /> Dismiss all
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {result.emails.length === 0 && <EmptyState icon={Inbox} title="No emails matched" />}
        {result.emails.map((email) => (
          <EmailCard
            key={email.id}
            email={email}
            decision={decisions[email.id] ?? null}
            draft={drafts[email.id] ?? null}
            onDraftChange={(d) => setDrafts((prev) => ({ ...prev, [email.id]: d }))}
            editable={actionable && Boolean(email.draft) && (!decisions[email.id] || decisions[email.id].status === "failed")}
            canSend={canSend}
            selected={selected.has(email.id)}
            onToggle={() => toggle(email.id)}
            busy={busy}
            onSend={() => requestSend([email.id])}
            onSkip={() => skip([email.id])}
          />
        ))}
      </div>

      <ConfirmDialog
        open={confirm?.kind === "send"}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "send" && confirmSend(confirm.items)}
        busy={busy === "send"}
        title="Send emails?"
        confirmLabel={confirm?.kind === "send" ? `Send ${confirm.items.length}` : "Send"}
      >
        {confirm?.kind === "send" && (
          <div className="space-y-3 text-sm">
            <p>
              This sends {confirm.items.length} email{confirm.items.length === 1 ? "" : "s"} from your Gmail account
              {gmail.info?.account ? ` (${gmail.info.account})` : ""}. This can&apos;t be undone.
            </p>
            <ul className="space-y-1 text-muted-foreground">
              {confirm.items.map((i) => (
                <li key={i.email_id} className="truncate">
                  <span className="text-foreground">{i.to}</span> — {i.subject}
                </li>
              ))}
            </ul>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "dismiss"}
        onClose={() => setConfirm(null)}
        onConfirm={dismissAll}
        busy={busy === "dismiss"}
        tone="danger"
        title="Dismiss all drafts?"
        description="The remaining drafts are discarded and nothing is sent. Emails already sent are not affected."
        confirmLabel="Dismiss all"
      />
    </div>
  );
}

function EmailCard({
  email,
  decision,
  draft,
  onDraftChange,
  editable,
  canSend,
  selected,
  onToggle,
  busy,
  onSend,
  onSkip,
}: {
  email: ProcessedEmail;
  decision: Decision | null;
  draft: Draft | null;
  onDraftChange: (d: Draft) => void;
  editable: boolean;
  canSend: boolean;
  selected: boolean;
  onToggle: () => void;
  busy: string | null;
  onSend: () => void;
  onSkip: () => void;
}) {
  const [showDraft, setShowDraft] = React.useState(editable);
  const [copied, setCopied] = React.useState(false);
  const e = email.entities ?? { dates: [], amounts: [], emails: [], phones: [], names: [] };
  const hasEntities = [e.dates, e.amounts, e.emails, e.phones].some((l) => l?.length);

  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Couldn't copy to the clipboard. Select the text and copy it manually.", "danger");
    }
  }

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start gap-3">
          {editable && (
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={selected} onChange={onToggle} aria-label={`Select reply to ${email.subject}`} />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="break-words leading-snug">{email.subject}</CardTitle>
            <p className="truncate text-xs text-muted-foreground">
              {email.from || "Unknown sender"}
              {email.source === "gmail" ? " · Gmail" : " · Pasted"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <Badge tone="primary">{CATEGORY_LABEL[email.category] ?? humanize(email.category)}</Badge>
            <Badge tone={PRIORITY_TONE[email.priority] ?? "neutral"}>{humanize(email.priority)} priority</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{email.summary}</p>
        {email.action_items?.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Action items</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {email.action_items.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {hasEntities && (
          <div className="space-y-1.5">
            <ChipList label="Dates" items={e.dates} />
            <ChipList label="Amounts" items={e.amounts} />
            <ChipList label="Emails" items={e.emails} />
            <ChipList label="Phones" items={e.phones} />
          </div>
        )}
        {email.follow_up && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Follow up:</span> {email.follow_up.reason}
            {email.follow_up.due_hint ? ` (mentioned: ${email.follow_up.due_hint})` : ""}
          </p>
        )}
        {!email.needs_reply && !email.draft && <p className="text-xs text-muted-foreground">No reply needed.</p>}

        {decision && <DecisionLine decision={decision} />}

        {email.draft && draft && (
          <div className="rounded-lg border bg-muted/30">
            <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium" onClick={() => setShowDraft((s) => !s)} aria-expanded={showDraft}>
              <span>Draft reply</span>
              <span className="text-muted-foreground">{showDraft ? "Hide" : "Show"}</span>
            </button>
            {showDraft && (
              <div className="space-y-2 border-t p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="To">
                    <Input value={draft.to} onChange={(ev) => onDraftChange({ ...draft, to: ev.target.value })} disabled={!editable} placeholder="name@example.com" maxLength={320} />
                  </Field>
                  <Field label="Subject">
                    <Input value={draft.subject} onChange={(ev) => onDraftChange({ ...draft, subject: ev.target.value })} disabled={!editable} maxLength={300} />
                  </Field>
                </div>
                <Field label="Message">
                  <Textarea rows={8} value={draft.body} onChange={(ev) => onDraftChange({ ...draft, body: ev.target.value })} disabled={!editable} maxLength={20000} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {editable && canSend && (
                    <Button size="sm" onClick={onSend} disabled={busy !== null}>
                      <Send /> Send
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={copy}>
                    {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy draft"}
                  </Button>
                  {editable && (
                    <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy !== null} loading={busy === `skip:${email.id}`}>
                      Skip
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionLine({ decision }: { decision: Decision }) {
  const when = formatDateTime(decision.at);
  if (decision.status === "sent")
    return (
      <p className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground")}>
        <Badge tone="success">Sent</Badge> to {decision.to ?? "recipient"} · {when}
        {decision.by === "automation-rule" && <Badge tone="neutral">Auto-sent by rule</Badge>}
      </p>
    );
  if (decision.status === "skipped")
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge tone="neutral">Skipped</Badge> {when}
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-danger">
      <Badge tone="danger">Failed</Badge> {decision.error ?? "Sending failed."} · {when}
    </p>
  );
}

