"use client";

import { useRef, useState } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Lightbulb, MessageSquareText, Sparkles, Upload } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, StatCard, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { BarListChart, TimeSeriesChart } from "@/components/charts";
import type { AnalyticsResult, Kpi } from "@/lib/agents/logic/analytics";
import { cn, downloadText, formatCurrency, formatNumber } from "@/lib/utils";
import { startRun } from "../run-request";
import type { InputPanelProps, ResultViewProps } from "../types";

const EXAMPLES = [
  "Which products generated the highest revenue this month?",
  "What is the overall revenue trend?",
  "What is our total revenue?",
];

export function AnalyticsInputPanel({ slug, canWrite, blockedReason, onStarted }: InputPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const disabled = !canWrite || Boolean(blockedReason);

  function pick(f: File | undefined | null) {
    setError(null);
    if (!f) return;
    if (!/\.(csv|xlsx)$/i.test(f.name)) {
      setError("Choose a .csv or .xlsx file.");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError("The file is larger than 5 MB.");
      return;
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a file to analyze.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (question.trim()) form.set("question", question.trim());
      onStarted(await startRun(slug, form));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {blockedReason && <Alert tone="warning">{blockedReason}</Alert>}
      {!canWrite && <Alert tone="info">You have view-only access.</Alert>}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={cn("rounded-lg border border-dashed p-5 text-center transition-colors", dragging ? "border-primary bg-primary-soft" : "bg-muted/40")}
      >
        {file ? (
          <div className="flex items-center justify-center gap-2 text-sm">
            <FileSpreadsheet className="size-4 text-primary" />
            <span className="max-w-[220px] truncate font-medium">{file.name}</span>
            <span className="text-muted-foreground">{formatNumber(file.size / 1024, 0)} KB</span>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setFile(null)}>
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <Upload className="mx-auto size-5 text-muted-foreground" />
            <p className="text-sm">Drop a CSV or Excel file here</p>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={disabled}>
              Choose file
            </Button>
            <p className="text-xs text-muted-foreground">Up to 5 MB and 50,000 rows. First row must be column names.</p>
          </div>
        )}
        <input ref={fileRef} type="file" accept=".csv,.xlsx" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label="Dataset file" />
      </div>
      <p className="text-xs text-muted-foreground">
        No data handy? Try the{" "}
        <a className="text-primary hover:underline" href="/samples/sample-sales.csv" download>
          sample sales file
        </a>{" "}
        (fictional demo data).
      </p>
      <Field label="Question (optional)" hint="Ask in plain language. Figures are computed from your file.">
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} placeholder={EXAMPLES[0]} disabled={disabled} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((q) => (
          <button key={q} type="button" onClick={() => setQuestion(q)} className="rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" disabled={disabled}>
            {q}
          </button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" className="w-full" loading={loading} disabled={disabled || !file}>
        <Sparkles /> Run analysis
      </Button>
    </form>
  );
}

function kpiValue(k: Kpi, currency: string) {
  if (k.value === null) return "—";
  if (k.format === "currency") return formatCurrency(Number(k.value), currency, Math.abs(Number(k.value)) >= 1_000_000);
  if (k.format === "percent") return `${k.value}%`;
  if (k.format === "number") return formatNumber(Number(k.value), 2);
  return String(k.value);
}

function reportMarkdown(r: AnalyticsResult, question?: string) {
  const lines = [
    `# Analysis report — ${r.dataset.name}`,
    "",
    `Generated ${new Date().toLocaleString()}. Figures computed from the uploaded file${r.ai_generated ? "; narrative written by AI from those figures" : ""}.`,
    "",
    "## Summary",
    r.summary,
    "",
    "## Key figures",
    ...r.kpis.map((k) => `- **${k.label}:** ${kpiValue(k, r.currency)}${k.change_pct != null ? ` (${k.change_pct > 0 ? "+" : ""}${k.change_pct}% ${k.note ?? ""})` : ""}`),
  ];
  if (question && r.answer) lines.push("", "## Question", `> ${question}`, "", r.answer.text);
  if (r.charts.top_items.length) {
    lines.push("", "## Top items", "| Item | Value | Share |", "|---|---:|---:|", ...r.charts.top_items.map((t) => `| ${t.name.replace(/\|/g, "/")} | ${t.value} | ${t.share_pct}% |`));
  }
  if (r.charts.value_over_time.length) {
    lines.push("", `## ${r.dataset.value_label} by ${r.charts.granularity}`, "| Period | Value |", "|---|---:|", ...r.charts.value_over_time.map((p) => `| ${p.period} | ${p.value} |`));
  }
  if (r.anomalies.length) lines.push("", "## Unusual patterns", ...r.anomalies.map((a) => `- ${a.description}${a.rows?.length ? ` (rows ${a.rows.slice(0, 20).join(", ")})` : ""}`));
  if (r.opportunities.length) lines.push("", "## Opportunities", ...r.opportunities.map((o) => `- ${o}`));
  lines.push("", "## Data quality", `- Rows without a readable value: ${r.data_quality.unparseable_values}`, `- Rows without a readable date: ${r.data_quality.rows_without_date}`);
  return lines.join("\n");
}

export function AnalyticsResultView({ execution, currency: orgCurrency }: ResultViewProps) {
  const r = execution.result as AnalyticsResult;
  if (!r?.kpis) return <Alert tone="warning">This run returned a result in an unexpected format.</Alert>;
  const currency = r.currency || orgCurrency;
  const isCurrency = r.metrics.revenue_total > 0;
  const question = typeof execution.input_summary.question === "string" ? execution.input_summary.question : undefined;
  const d = r.dataset.detected;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {r.kpis.map((k) => (
          <StatCard
            key={k.key}
            label={k.label}
            value={<span className={cn(k.format === "text" && "text-lg")}>{kpiValue(k, currency)}</span>}
            hint={
              k.change_pct != null ? (
                <span className={k.change_pct >= 0 ? "text-success" : "text-danger"}>
                  {k.change_pct > 0 ? "+" : ""}
                  {k.change_pct}% {k.note}
                </span>
              ) : (
                k.note
              )
            }
          />
        ))}
      </div>

      {r.answer && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="size-4 text-primary" /> {r.answer.question}
            </CardTitle>
            <CardDescription>{r.answer.source === "ai" ? "Answered by AI using the computed figures below." : "Computed directly from your file."}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-sm leading-relaxed">{r.answer.text}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle>Summary</CardTitle>
            <CardDescription>{r.summary_source === "ai" ? "Written by AI from the computed figures." : "Computed summary (AI narrative not used for this run)."}</CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={() => downloadText(`analysis-${execution.id.slice(0, 8)}.md`, reportMarkdown(r, question), "text/markdown")}>
              <Download /> Report
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed">{r.summary}</p>
          {r.insights.length > 0 && (
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {r.insights.map((i, n) => (
                <li key={n} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                  {i}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {r.charts.value_over_time.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {r.dataset.value_label} by {r.charts.granularity}
            </CardTitle>
            <CardDescription>
              {r.dataset.date_range ? `${r.dataset.date_range.start} to ${r.dataset.date_range.end}` : ""} · date column “{d.date}”
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TimeSeriesChart data={r.charts.value_over_time} xKey="period" yKey="value" label={r.dataset.value_label} format={isCurrency ? "currency" : "number"} currency={currency} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {r.charts.top_items.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Top items</CardTitle>
              <CardDescription>By {r.dataset.value_label.toLowerCase()} · column “{d.product}”</CardDescription>
            </CardHeader>
            <CardContent>
              <BarListChart data={r.charts.top_items} nameKey="name" valueKey="value" label={r.dataset.value_label} format={isCurrency ? "currency" : "number"} currency={currency} />
            </CardContent>
          </Card>
        )}
        {r.charts.by_category.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>By {d.category}</CardTitle>
            </CardHeader>
            <CardContent>
              <BarListChart data={r.charts.by_category} nameKey="name" valueKey="value" label={r.dataset.value_label} format={isCurrency ? "currency" : "number"} currency={currency} />
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" /> Unusual patterns
            </CardTitle>
          </CardHeader>
          <CardContent>
            {r.anomalies.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing unusual detected with the current checks.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {r.anomalies.map((a, i) => (
                  <li key={i} className="rounded-md border p-2.5">
                    <Badge tone="warning" className="mb-1">
                      {a.type.replace("_", " ")}
                    </Badge>
                    <p>{a.description}</p>
                    {a.rows && a.rows.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Rows: {a.rows.slice(0, 20).join(", ")}{a.rows.length > 20 ? "…" : ""}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="size-4 text-primary" /> Opportunities
            </CardTitle>
          </CardHeader>
          <CardContent>
            {r.opportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground">No opportunities stand out from these figures alone.</p>
            ) : (
              <ul className="list-disc space-y-1.5 pl-4 text-sm">
                {r.opportunities.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>About this dataset</CardTitle>
          <CardDescription>
            {formatNumber(r.dataset.row_count)} rows · {r.dataset.column_count} columns · {r.dataset.name}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <THead>
              <TR>
                <TH>Detected as</TH>
                <TH>Column</TH>
              </TR>
            </THead>
            <TBody>
              {Object.entries(d)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <TR key={k}>
                    <TD className="capitalize text-muted-foreground">{k}</TD>
                    <TD className="font-mono text-xs">{v}</TD>
                  </TR>
                ))}
            </TBody>
          </Table>
          {(r.data_quality.unparseable_values > 0 || r.data_quality.rows_without_date > 0 || r.data_quality.missing_values.length > 0) && (
            <div className="space-y-1 px-5 pt-3 text-xs text-muted-foreground">
              {r.data_quality.unparseable_values > 0 && <p>{r.data_quality.unparseable_values} row(s) had no readable value and were skipped.</p>}
              {r.data_quality.rows_without_date > 0 && <p>{r.data_quality.rows_without_date} row(s) had no readable date (counted in totals, not in the trend).</p>}
              {r.data_quality.missing_values.length > 0 && <p>Empty cells: {r.data_quality.missing_values.map((m) => `${m.column} (${m.count})`).join(", ")}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
