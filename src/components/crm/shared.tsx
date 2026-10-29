"use client";

import * as React from "react";
import { Badge, Button, Label } from "@/components/ui";
import { Dialog, toast } from "@/components/ui/client";
import { cn, formatDate, formatDateTime, timeAgo } from "@/lib/utils";
import { CONSENT_META, STAGE_META, STATUS_META, isContactStatus, isDealStage, type ConsentStatus } from "./constants";
import { useHydrated } from "./hooks";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = isContactStatus(status) ? STATUS_META[status] : { label: status, tone: "neutral" as const };
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  const meta = isDealStage(stage) ? STAGE_META[stage] : { label: stage, tone: "neutral" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function ConsentBadge({ consent }: { consent: string }) {
  const meta = CONSENT_META[consent as ConsentStatus] ?? CONSENT_META.unknown;
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function LeadScore({ score, className }: { score: number | null | undefined; className?: string }) {
  if (score === null || score === undefined) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const tone = score >= 70 ? "bg-success" : score >= 40 ? "bg-warning" : "bg-muted-foreground/50";
  return (
    <span className={cn("inline-flex items-center gap-2 tabular-nums", className)} title={`Lead score ${score} of 100`}>
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </span>
      {score}
    </span>
  );
}

export function AutomationBadge() {
  return (
    <Badge tone="primary" title="Created by a CRM automation">
      Automation
    </Badge>
  );
}

export function DraftBadge() {
  return (
    <Badge tone="warning" title="This email was drafted by an automation and has not been sent">
      Draft — not sent
    </Badge>
  );
}

/** Renders a timestamp in the viewer's timezone (empty during SSR to avoid hydration mismatches). */
export function LocalTime({ value, mode = "datetime", className }: { value: string | Date | null | undefined; mode?: "datetime" | "date" | "ago"; className?: string }) {
  const hydrated = useHydrated();
  if (!value) return <span className={className}>—</span>;
  const d = typeof value === "string" ? new Date(value) : value;
  const text = !hydrated ? "" : mode === "date" ? formatDate(d) : mode === "ago" ? timeAgo(d) : formatDateTime(d);
  return (
    <time dateTime={d.toISOString()} title={hydrated && mode !== "datetime" ? formatDateTime(d) : undefined} className={className}>
      {text}
    </time>
  );
}

/** Form field with a properly associated label and error message. */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** aria props for an input inside <FormField>. */
export function fieldAria(id: string, error?: string) {
  return error ? { id, "aria-invalid": true as const, "aria-describedby": `${id}-error` } : { id };
}

export type FieldErrors = Record<string, string>;

/** Map the API's zod `details` ([{ path, message }]) to { field: message }. */
export function toFieldErrors(err: unknown): FieldErrors {
  const details = (err as { details?: unknown } | null)?.details;
  const out: FieldErrors = {};
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && typeof d === "object" && typeof d.message === "string") {
        const key = typeof d.path === "string" && d.path ? d.path.split(".")[0] : "_form";
        if (!out[key]) out[key] = d.message;
      }
    }
  }
  return out;
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

export function errorCode(err: unknown) {
  return (err as { code?: string } | null)?.code;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel = "Delete",
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted-foreground">{children}</div>
    </Dialog>
  );
}
