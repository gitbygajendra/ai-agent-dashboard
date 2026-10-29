"use client";

import * as React from "react";
import { Alert, Badge, Button } from "@/components/ui";
import { Dialog } from "@/components/ui/client";
import { api, cn } from "@/lib/utils";

/* Helpers shared by the agent panels. Not part of the public panel API. */

export type FieldIssue = { path: string; message: string };
export type FormError = { message: string; issues: FieldIssue[] };

/** Normalize a thrown error (from startRun/api) into a message plus field issues. */
export function toFormError(err: unknown): FormError {
  const e = err as (Error & { details?: unknown }) | null;
  const message = e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";
  const issues: FieldIssue[] = [];
  if (Array.isArray(e?.details)) {
    for (const d of e.details as unknown[]) {
      if (d && typeof d === "object" && typeof (d as FieldIssue).message === "string") {
        issues.push({ path: String((d as FieldIssue).path ?? ""), message: (d as FieldIssue).message });
      }
    }
  }
  return { message, issues };
}

export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** "emails.0.body" → "Email 1 › body". */
export function prettyPath(path: string): string {
  if (!path) return "";
  return path
    .split(".")
    .map((p) => (/^\d+$/.test(p) ? `#${Number(p) + 1}` : p.replace(/_/g, " ")))
    .join(" › ");
}

export function FormErrorAlert({ error, className }: { error: FormError | null; className?: string }) {
  if (!error) return null;
  return (
    <Alert tone="danger" title={error.message} className={className}>
      {error.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4">
          {error.issues.slice(0, 8).map((i, idx) => (
            <li key={idx}>
              {i.path && <span className="font-medium text-foreground">{prettyPath(i.path)}: </span>}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Banner shown above input panels when the run is blocked or the user is a viewer. */
export function RunGate({ blockedReason, canWrite }: { blockedReason: string | null; canWrite: boolean }) {
  if (blockedReason) return <Alert tone="warning" title="This agent can't run right now">{blockedReason}</Alert>;
  if (!canWrite) return <Alert tone="info">You have view-only access. Ask an admin or member to run this agent.</Alert>;
  return null;
}

/**
 * Small fetch hook. Re-fetches when `url` or `refreshKey` changes, or when reload() is called.
 * Data is kept while re-fetching the same URL so the UI doesn't flash.
 */
export function useApi<T>(url: string | null, refreshKey: string | number = "") {
  const [nonce, setNonce] = React.useState(0);
  const key = url ? `${url}#${refreshKey}#${nonce}` : null;
  const [state, setState] = React.useState<{ key: string | null; url: string | null; data: T | null; error: string | null }>({
    key: null,
    url: null,
    data: null,
    error: null,
  });

  React.useEffect(() => {
    if (!url || !key) return;
    let cancelled = false;
    api<T>(url).then(
      (data) => {
        if (!cancelled) setState({ key, url, data, error: null });
      },
      (err) => {
        if (!cancelled) setState((s) => ({ key, url, data: s.url === url ? s.data : null, error: errorMessage(err, "Could not load data.") }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, key]);

  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  const mutate = React.useCallback((fn: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: fn(s.data) })), []);
  const sameUrl = state.url === url;
  return {
    data: url && sameUrl ? state.data : null,
    error: url && state.key === key ? state.error : null,
    loading: key !== null && state.key !== key,
    reload,
    mutate,
  };
}

export type IntegrationInfo = {
  provider: string;
  state: "connected" | "not_connected" | "needs_attention" | string;
  detail: string;
  account: string | null;
  canConnect?: boolean;
};

/** Connection state for one provider from GET /api/integrations. */
export function useIntegration(provider: string) {
  const { data, error, loading } = useApi<{ integrations: IntegrationInfo[] }>("/api/integrations");
  const info = data?.integrations?.find((i) => i.provider === provider) ?? null;
  return { loading: loading && !data, error, info, connected: info?.state === "connected" };
}

/** Badge that says whether a piece of text was written by AI or computed from data. */
export function SourceBadge({ ai, className }: { ai: boolean; className?: string }) {
  return ai ? (
    <Badge tone="primary" className={className}>
      AI-generated
    </Badge>
  ) : (
    <Badge tone="neutral" className={className}>
      Computed from your data
    </Badge>
  );
}

/** Escape one CSV value; neutralize spreadsheet formula injection. */
export function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = typeof v === "string" ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvValue).join(",")).join("\r\n");
}

/** Escape text for a Markdown table cell. */
export function mdCell(v: unknown): string {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  tone = "default",
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  busy?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === "danger" ? "danger" : "default"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? <p className="text-sm text-muted-foreground">{description}</p>}
    </Dialog>
  );
}

/** A labelled list of small chips; renders nothing when empty. */
export function ChipList({ label, items, className }: { label: string; items: string[] | null | undefined; className?: string }) {
  if (!items?.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((v, i) => (
        <Badge key={`${v}-${i}`} tone="outline" className="max-w-full truncate font-normal">
          {v}
        </Badge>
      ))}
    </div>
  );
}

export function SectionTitle({ children, aside, className }: { children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <h3 className="text-sm font-semibold">{children}</h3>
      {aside}
    </div>
  );
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/[_.]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const FILE_ACCEPT_TABULAR = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isTabularFile(f: File | null | undefined): boolean {
  return Boolean(f && /\.(csv|xlsx)$/i.test(f.name));
}

/** Native file input styled to match the design system. */
export function FileInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="file"
      {...props}
      className={cn(
        "block w-full rounded-md border border-input bg-card text-sm text-muted-foreground file:mr-3 file:h-9 file:border-0 file:border-r file:border-input file:bg-muted file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70 disabled:opacity-50",
        props.className,
      )}
    />
  );
}
