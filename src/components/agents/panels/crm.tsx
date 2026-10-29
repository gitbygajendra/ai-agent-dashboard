"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, ClipboardList, Mail, UserCheck, Users, Zap } from "lucide-react";
import { Alert, Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@/components/ui";
import type { CrmAction, CrmEventResult } from "@/lib/agents/logic/crm";
import type { InputPanelProps, ResultViewProps } from "../types";
import { humanize, SourceBadge } from "./shared";

/* ------------------------------------------------------------------ */
/* Input (no manual run)                                               */
/* ------------------------------------------------------------------ */

/** Mirrors the rules in src/lib/agents/logic/crm.ts (planCrmEvent). */
const RULES: { when: string; then: string }[] = [
  { when: "New lead added (status lead or qualified)", then: "Follow-up task due in 1 day, plus an intro email draft saved for review (skipped if the contact opted out)." },
  { when: "Contact changes to qualified", then: "Task to book a discovery call, due in 2 days." },
  { when: "Deal created", then: "Qualification task due in 2 days." },
  { when: "Deal moves to qualified / proposal / negotiation", then: "Prepare proposal (3 days) / follow up on proposal (2 days) / check in on negotiation (3 days)." },
  { when: "Deal won", then: "Onboarding task due in 1 day and the contact is marked as a customer." },
  { when: "Deal lost", then: "Task to ask for feedback, due in 2 days." },
];

export function CrmInputPanel({ blockedReason }: InputPanelProps) {
  return (
    <div className="space-y-4">
      {blockedReason && (
        <Alert tone="warning" title="Automations are paused">
          {blockedReason}
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        This agent has no manual input. It runs automatically when leads and deals change in your CRM, and each run shows up here.
      </p>
      <ol className="space-y-2.5">
        {RULES.map((r) => (
          <li key={r.when} className="flex gap-2.5 text-sm">
            <Zap className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>
              <span className="font-medium">{r.when}</span>
              <span className="text-muted-foreground"> → {r.then}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">Email drafts are never sent automatically; they appear as activities on the contact for you to review.</p>
      <Link href="/crm" className={buttonVariants({ variant: "outline", size: "sm" })}>
        Open CRM <ArrowRight />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

const EVENT_LABEL: Record<string, string> = {
  "contact.created": "Contact created",
  "contact.updated": "Contact updated",
  "deal.created": "Deal created",
  "deal.stage_changed": "Deal stage changed",
};

function ActionRow({ action }: { action: CrmAction }) {
  if (action.type === "create_task") {
    return (
      <li className="flex gap-3">
        <ClipboardList className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 text-sm">
          <p className="font-medium">{action.subject}</p>
          <p className="text-xs text-muted-foreground">
            Task · due in {action.due_in_days} day{action.due_in_days === 1 ? "" : "s"}
            {action.body ? ` · ${action.body}` : ""}
          </p>
        </div>
      </li>
    );
  }
  if (action.type === "update_contact_status") {
    return (
      <li className="flex gap-3">
        <UserCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm">
          Update contact status to <Badge tone="primary">{humanize(action.status)}</Badge>
        </p>
      </li>
    );
  }
  return (
    <li className="flex gap-3">
      <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">Email draft: {action.subject}</p>
        <p className="text-xs text-muted-foreground">To {action.to} · saved for review, not sent</p>
        <details className="mt-1.5">
          <summary className="cursor-pointer text-xs text-primary">Show draft</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-xs">{action.body}</pre>
        </details>
      </div>
    </li>
  );
}

export function CrmResultView({ execution }: ResultViewProps) {
  const result = execution.result as (CrmEventResult & { applied?: string[] }) | null;
  if (!result || !result.event) {
    return <EmptyState icon={Users} title="No automation result" description="This run didn't return a plan." />;
  }
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const log = Array.isArray(result.log) ? result.log : [];
  const applied = Array.isArray(result.applied) ? result.applied : null;
  const subject = typeof execution.input_summary?.name === "string" ? execution.input_summary.name : null;
  const hasDraft = actions.some((a) => a.type === "create_email_draft");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">{EVENT_LABEL[result.event] ?? humanize(result.event)}</Badge>
        {subject && <span className="text-sm font-medium">{subject}</span>}
        {hasDraft && <SourceBadge ai={Boolean(result.ai_generated)} className="ml-auto" />}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Planned actions</CardTitle>
          </CardHeader>
          <CardContent>
            {actions.length ? (
              <ul className="space-y-3">
                {actions.map((a, i) => (
                  <ActionRow key={i} action={a} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No rule matched this event, so nothing was planned.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Applied to CRM</CardTitle>
          </CardHeader>
          <CardContent>
            {applied === null ? (
              <p className="text-sm text-muted-foreground">
                {execution.status === "succeeded" ? "No changes were recorded for this run." : "Changes are applied when the run finishes."}
              </p>
            ) : applied.length ? (
              <ul className="space-y-2">
                {applied.map((a, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                    {a}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing needed to change.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 font-mono text-xs text-muted-foreground">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
