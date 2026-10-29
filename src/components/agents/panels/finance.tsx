"use client";

import * as React from "react";
import { Calculator, Download, FileText, SearchCheck } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, StatCard, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { AiBadge } from "@/components/status";
import { GroupedColumnsChart } from "@/components/charts";
import type { Finding, FinanceResult } from "@/lib/agents/logic/finance";
import { downloadText, formatCurrency, formatDate, formatNumber } from "@/lib/utils";
import { startRun } from "../run-request";
import type { InputPanelProps, ResultViewProps } from "../types";
import { FILE_ACCEPT_TABULAR, FileInput, FormErrorAlert, type FormError, isTabularFile, mdCell, RunGate, SourceBadge, toCsv, toFormError } from "./shared";

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export function FinanceInputPanel({ canWrite, blockedReason, onStarted }: InputPanelProps) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [windowDays, setWindowDays] = React.useState("7");
  const [hasTxn, setHasTxn] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);
  const disabled = !canWrite || Boolean(blockedReason) || submitting;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    const form = new FormData(e.currentTarget);
    const txn = form.get("transactions");
    const inv = form.get("invoices");
    if (!(txn instanceof File) || txn.size === 0) return setError({ message: "Choose a transactions file (.csv or .xlsx).", issues: [] });
    if (!isTabularFile(txn)) return setError({ message: "Transactions must be a .csv or .xlsx file.", issues: [] });
    if (inv instanceof File && inv.size > 0 && !isTabularFile(inv)) return setError({ message: "Invoices must be a .csv or .xlsx file.", issues: [] });
    if (!(inv instanceof File) || inv.size === 0) form.delete("invoices");
    const days = Number(windowDays);
    if (!Number.isFinite(days) || days < 0 || days > 60) return setError({ message: "Date window must be between 0 and 60 days.", issues: [] });
    form.set("date_window_days", String(Math.round(days)));
    setSubmitting(true);
    try {
      const execution = await startRun("finance-audit-agent", form);
      onStarted(execution);
      formRef.current?.reset();
      setHasTxn(false);
      setWindowDays("7");
    } catch (err) {
      setError(toFormError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-4" noValidate>
      <RunGate blockedReason={blockedReason} canWrite={canWrite} />
      <Field label="Transactions (required)" hint="Bank or ledger export: date, amount (or debit/credit), description, reference / invoice no., vendor or customer, category.">
        <FileInput name="transactions" accept={FILE_ACCEPT_TABULAR} disabled={!canWrite} onChange={(e) => setHasTxn(Boolean(e.target.files?.length))} />
      </Field>
      <Field label="Invoices (optional)" hint="Invoice number, date, amount and customer. Used to find missing or mismatched payments.">
        <FileInput name="invoices" accept={FILE_ACCEPT_TABULAR} disabled={!canWrite} />
      </Field>
      <Field label="Date matching window (days)" hint="How far apart an invoice and its payment can be. 0–60.">
        <Input type="number" min={0} max={60} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} className="w-28" />
      </Field>
      <FormErrorAlert error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={disabled || !hasTxn} loading={submitting}>
          <SearchCheck /> Run review
        </Button>
        <p className="text-xs text-muted-foreground">Files are stored privately. This is a reconciliation aid, not a formal audit.</p>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

const TYPE_LABEL: Record<Finding["type"], string> = {
  duplicate: "Possible duplicate",
  unusual_expense: "Unusual expense",
  missing_payment: "Missing payment",
  amount_mismatch: "Amount mismatch",
  matched_by_amount: "Matched by amount only",
  invalid_row: "Invalid row",
};
const SEVERITY_TONE = { high: "danger", medium: "warning", low: "neutral" } as const;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function sourceText(f: Finding): string {
  return (f.sources ?? []).map((s) => `${s.file} row${s.rows.length === 1 ? "" : "s"} ${s.rows.join(", ")}`).join("; ");
}

export function FinanceResultView(props: ResultViewProps) {
  const result = props.execution.result as FinanceResult | null;
  if (!result || !result.summary) {
    return <EmptyState icon={Calculator} title="No finance results" description="This run didn't return a summary." />;
  }
  return <FinanceResultInner key={props.execution.id} {...props} result={result} />;
}

function FinanceResultInner({ execution, currency: orgCurrency, result }: ResultViewProps & { result: FinanceResult }) {
  const currency = result.currency || orgCurrency;
  const money = (n: number | null | undefined) => formatCurrency(n, currency);
  const [severity, setSeverity] = React.useState<"all" | Finding["severity"]>("all");
  const [type, setType] = React.useState<"all" | Finding["type"]>("all");
  const [limit, setLimit] = React.useState(50);

  const findings = React.useMemo(
    () => [...(result.findings ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [result.findings],
  );
  const filtered = findings.filter((f) => (severity === "all" || f.severity === severity) && (type === "all" || f.type === type));
  const types = [...new Set(findings.map((f) => f.type))];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const categories = [...(result.categories ?? [])].sort((a, b) => b.total - a.total);
  const s = result.summary;
  const r = result.reconciliation;
  const stamp = (execution.completed_at ?? execution.created_at).slice(0, 10);

  function exportCsv() {
    const csv = toCsv(
      ["id", "severity", "type", "description", "amount", "reference", "sources"],
      filtered.map((f) => [f.id, f.severity, TYPE_LABEL[f.type] ?? f.type, f.description, f.amount, f.reference, sourceText(f)]),
    );
    downloadText(`finance-findings-${stamp}.csv`, csv, "text/csv;charset=utf-8");
  }

  function exportMarkdown() {
    const lines: string[] = [
      "# Finance review report",
      "",
      `Generated ${new Date(execution.completed_at ?? execution.created_at).toISOString()} · Run ${execution.id}`,
      "",
      `> ${result.disclaimer.replace(/\r?\n/g, " ")}`,
      "",
      "## Summary (computed)",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Income | ${mdCell(money(s.income_total))} |`,
      `| Expenses | ${mdCell(money(s.expense_total))} |`,
      `| Net profit | ${mdCell(money(s.net_profit))} |`,
      `| Transactions | ${s.transaction_count} |`,
      `| Invoices | ${s.invoice_count} |`,
      ...(s.period ? [`| Period | ${mdCell(`${s.period.start} to ${s.period.end}`)} |`] : []),
      "",
    ];
    if (r) {
      lines.push(
        "## Reconciliation (computed)",
        "",
        "| Invoices | Matched by reference | Matched by amount | Missing payments | Mismatched |",
        "| --- | --- | --- | --- | --- |",
        `| ${r.invoices} | ${r.matched_by_reference} | ${r.matched_by_amount} | ${r.missing_payments} | ${r.mismatched} |`,
        "",
      );
    }
    if (result.monthly?.length) {
      lines.push("## Monthly (computed)", "", "| Month | Income | Expenses | Net |", "| --- | --- | --- | --- |");
      for (const m of result.monthly) lines.push(`| ${mdCell(m.month)} | ${mdCell(money(m.income))} | ${mdCell(money(m.expense))} | ${mdCell(money(m.net))} |`);
      lines.push("");
    }
    if (categories.length) {
      lines.push("## Categories (computed)", "", "| Category | Type | Count | Total |", "| --- | --- | --- | --- |");
      for (const c of categories) lines.push(`| ${mdCell(c.category)} | ${c.type} | ${c.count} | ${mdCell(money(c.total))} |`);
      lines.push("");
    }
    lines.push(`## Findings (${findings.length})`, "");
    if (findings.length) {
      lines.push("| Severity | Type | Description | Amount | Reference | Source |", "| --- | --- | --- | --- | --- | --- |");
      for (const f of findings) {
        lines.push(`| ${f.severity} | ${mdCell(TYPE_LABEL[f.type] ?? f.type)} | ${mdCell(f.description)} | ${mdCell(f.amount === null ? "" : money(f.amount))} | ${mdCell(f.reference ?? "")} | ${mdCell(sourceText(f))} |`);
      }
    } else {
      lines.push("No findings.");
    }
    lines.push("", `## Explanation (${result.explanation_source === "ai" ? "AI-generated" : "computed"})`, "", result.explanation || "—", "");
    downloadText(`finance-report-${stamp}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
  }

  return (
    <div className="space-y-5">
      {result.disclaimer && <Alert tone="warning">{result.disclaimer}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {s.period ? `Period ${formatDate(s.period.start)} – ${formatDate(s.period.end)}. ` : ""}Figures below are computed directly from your files.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length}>
            <Download /> Findings CSV
          </Button>
          <Button size="sm" variant="outline" onClick={exportMarkdown}>
            <FileText /> Audit report (.md)
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Income" value={money(s.income_total)} tone="success" />
        <StatCard label="Expenses" value={money(s.expense_total)} />
        <StatCard label="Net profit" value={money(s.net_profit)} tone={s.net_profit < 0 ? "danger" : "success"} />
        <StatCard label="Transactions" value={formatNumber(s.transaction_count)} />
        <StatCard label="Invoices" value={formatNumber(s.invoice_count)} hint={s.invoice_count ? undefined : "No invoice file"} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Explanation</CardTitle>
            <span className="flex flex-wrap gap-2">
              <SourceBadge ai={result.explanation_source === "ai"} />
              <AiBadge status={execution.ai_status} />
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{result.explanation || "No explanation was produced."}</p>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Monthly income and expenses</CardTitle>
          </CardHeader>
          <CardContent>
            {result.monthly?.length ? (
              <GroupedColumnsChart
                data={result.monthly}
                xKey="month"
                currency={currency}
                series={[
                  { key: "income", label: "Income" },
                  { key: "expense", label: "Expenses" },
                ]}
              />
            ) : (
              <EmptyState title="No dated transactions" description="Add a date column to see the monthly breakdown." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invoice reconciliation</CardTitle>
            {!r && <CardDescription>No invoice file was provided, so invoices weren&apos;t reconciled.</CardDescription>}
          </CardHeader>
          {r && (
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Stat label="Invoices" value={r.invoices} />
                <Stat label="Matched by reference" value={r.matched_by_reference} tone="success" />
                <Stat label="Matched by amount only" value={r.matched_by_amount} tone={r.matched_by_amount ? "warning" : undefined} />
                <Stat label="Missing payments" value={r.missing_payments} tone={r.missing_payments ? "danger" : undefined} />
                <Stat label="Amount mismatches" value={r.mismatched} tone={r.mismatched ? "danger" : undefined} />
              </dl>
            </CardContent>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {categories.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>Category</TH>
                  <TH>Type</TH>
                  <TH className="text-right">Count</TH>
                  <TH className="text-right">Total</TH>
                </TR>
              </THead>
              <TBody>
                {categories.map((c) => (
                  <TR key={`${c.type}-${c.category}`}>
                    <TD>{c.category}</TD>
                    <TD>
                      <Badge tone={c.type === "income" ? "success" : "neutral"}>{c.type === "income" ? "Income" : "Expense"}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums">{formatNumber(c.count)}</TD>
                    <TD className="text-right tabular-nums">{money(c.total)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="px-5 pb-3 text-sm text-muted-foreground">No categories found.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Findings</CardTitle>
              <CardDescription>
                {findings.length
                  ? `${counts.high} high · ${counts.medium} medium · ${counts.low} low. Each finding cites the file and row it came from.`
                  : "No issues were flagged."}
              </CardDescription>
            </div>
            {findings.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} className="h-8 w-auto text-xs">
                  <option value="all">All severities</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </Select>
                <Select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value as typeof type)} className="h-8 w-auto text-xs">
                  <option value="all">All types</option>
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t] ?? t}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        </CardHeader>
        {findings.length > 0 && (
          <CardContent className="px-0 pb-2">
            {filtered.length ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Severity</TH>
                    <TH>Type</TH>
                    <TH className="min-w-64">Description</TH>
                    <TH className="text-right">Amount</TH>
                    <TH>Reference</TH>
                    <TH>Source</TH>
                  </TR>
                </THead>
                <TBody>
                  {filtered.slice(0, limit).map((f) => (
                    <TR key={f.id}>
                      <TD>
                        <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                      </TD>
                      <TD className="whitespace-nowrap">{TYPE_LABEL[f.type] ?? f.type}</TD>
                      <TD>{f.description}</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{f.amount === null ? "—" : money(f.amount)}</TD>
                      <TD className="whitespace-nowrap">{f.reference ?? "—"}</TD>
                      <TD className="text-xs text-muted-foreground">
                        {(f.sources ?? []).map((src, i) => (
                          <div key={i} className="whitespace-nowrap">
                            <span className="text-foreground">{src.file}</span> · row{src.rows.length === 1 ? "" : "s"} {src.rows.slice(0, 12).join(", ")}
                            {src.rows.length > 12 ? ` +${src.rows.length - 12} more` : ""}
                          </div>
                        ))}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="px-5 pb-3 text-sm text-muted-foreground">No findings match these filters.</p>
            )}
            {filtered.length > limit && (
              <div className="px-5 py-3">
                <Button size="sm" variant="outline" onClick={() => setLimit((l) => l + 100)}>
                  Show more ({filtered.length - limit} remaining)
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "";
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${color}`}>{formatNumber(value)}</dd>
    </div>
  );
}
