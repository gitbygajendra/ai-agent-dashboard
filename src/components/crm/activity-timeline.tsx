"use client";

import * as React from "react";
import { Bell, Bot, CalendarDays, CheckSquare, Copy, Mail, Phone, RefreshCw, StickyNote, Trash2, type LucideIcon } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Select, Spinner, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { api, cn } from "@/lib/utils";
import { ACTIVITY_LABELS, ACTIVITY_TYPES, activityKind, displaySubject, isDraft, isTaskType, type Activity, type ActivityType, type Deal } from "./constants";
import { isOverdue, localInputToIso } from "./dates";
import { useHydrated } from "./hooks";
import { AutomationBadge, ConfirmDialog, DraftBadge, FormField, LocalTime, errorMessage, fieldAria, toFieldErrors, type FieldErrors } from "./shared";

const ICONS: Record<ActivityType | "system", LucideIcon> = {
  note: StickyNote,
  task: CheckSquare,
  call: Phone,
  email: Mail,
  meeting: CalendarDays,
  reminder: Bell,
  system: Bot,
};

export function ActivityTimeline({
  contactId,
  deals,
  activities,
  canWrite,
  setActivities,
  onRefresh,
  refreshing,
}: {
  contactId: string;
  deals: Deal[];
  activities: Activity[];
  canWrite: boolean;
  setActivities: (fn: (prev: Activity[]) => Activity[]) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = React.useState<Activity | null>(null);
  const sorted = React.useMemo(() => [...activities].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [activities]);
  const dealTitles = React.useMemo(() => new Map(deals.map((d) => [d.id, d.title])), [deals]);

  async function toggle(a: Activity) {
    setBusy((b) => ({ ...b, [a.id]: true }));
    try {
      const res = await api<{ activity: Activity }>(`/api/crm/activities/${a.id}`, { method: "PATCH", json: { completed: !a.completed_at } });
      setActivities((prev) => prev.map((x) => (x.id === a.id ? res.activity : x)));
    } catch (err) {
      toast(`Couldn't update the task: ${errorMessage(err)}`, "danger");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[a.id];
        return next;
      });
    }
  }

  async function remove(a: Activity) {
    await api(`/api/crm/activities/${a.id}`, { method: "DELETE" });
    setActivities((prev) => prev.filter((x) => x.id !== a.id));
    toast("Activity deleted.", "success");
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Activity</CardTitle>
          <CardDescription>Notes, tasks and automation output. Email drafts are never sent automatically.</CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh activity">
          {refreshing ? <Spinner /> : <RefreshCw />}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {canWrite && <LogActivityForm contactId={contactId} deals={deals} onCreated={(a) => setActivities((prev) => [a, ...prev])} />}
        {sorted.length === 0 ? (
          <EmptyState title="No activity yet" description={canWrite ? "Log a note, call or task above. Automation follow-ups will also appear here." : "Notes, tasks and automation follow-ups will appear here."} />
        ) : (
          <ol className="space-y-0" aria-label="Activity timeline">
            {sorted.map((a) => (
              <TimelineItem
                key={a.id}
                activity={a}
                dealTitle={a.deal_id ? dealTitles.get(a.deal_id) : undefined}
                canWrite={canWrite}
                busy={!!busy[a.id]}
                onToggle={() => toggle(a)}
                onDelete={() => setToDelete(a)}
              />
            ))}
          </ol>
        )}
      </CardContent>
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} title="Delete activity?" onConfirm={() => (toDelete ? remove(toDelete) : Promise.resolve())}>
        &ldquo;{toDelete ? displaySubject(toDelete) : ""}&rdquo; will be permanently deleted.
      </ConfirmDialog>
    </Card>
  );
}

function TimelineItem({
  activity: a,
  dealTitle,
  canWrite,
  busy,
  onToggle,
  onDelete,
}: {
  activity: Activity;
  dealTitle?: string;
  canWrite: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const hydrated = useHydrated();
  const kind = activityKind(a);
  const Icon = a.execution_id && kind !== "email" && kind !== "task" ? ICONS.system : ICONS[kind];
  const task = isTaskType(a.type);
  const done = !!a.completed_at;
  const overdue = hydrated && task && !done && isOverdue(a.due_at);
  const draft = isDraft(a);
  const [expanded, setExpanded] = React.useState(false);
  const long = (a.body?.length ?? 0) > 320;
  const checkboxId = React.useId();

  return (
    <li className="relative flex gap-3 pb-5 before:absolute before:top-9 before:bottom-1 before:left-4 before:w-px before:bg-border last:pb-0 last:before:hidden">
      <span
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground",
          draft && "border-warning/40 bg-warning-soft text-warning",
          a.execution_id && !draft && "border-primary/30 bg-primary-soft text-primary",
          done && "text-success",
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
        <div className="flex items-start gap-2">
          {task && (
            <div className="flex h-5 items-center">
              {busy ? (
                <Spinner />
              ) : (
                <input
                  id={checkboxId}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={done}
                  disabled={!canWrite}
                  onChange={onToggle}
                  aria-label={done ? `Mark “${a.subject}” as not done` : `Mark “${a.subject}” complete`}
                />
              )}
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className={cn("text-sm font-medium break-words", done && "text-muted-foreground line-through")}>{displaySubject(a)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="outline">{ACTIVITY_LABELS[kind]}</Badge>
              {draft && <DraftBadge />}
              {a.execution_id && <AutomationBadge />}
              {task && done && <Badge tone="success">Done</Badge>}
              {overdue && <Badge tone="danger">Overdue</Badge>}
            </div>
          </div>
          <div className="flex shrink-0 items-center">
            {draft && a.body && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Copy draft text"
                onClick={() =>
                  navigator.clipboard.writeText(a.body ?? "").then(
                    () => toast("Draft copied to clipboard.", "success"),
                    () => toast("Couldn't copy the draft.", "danger"),
                  )
                }
              >
                <Copy />
              </Button>
            )}
            {canWrite && (
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-danger" aria-label={`Delete “${displaySubject(a)}”`} onClick={onDelete}>
                <Trash2 />
              </Button>
            )}
          </div>
        </div>
        {a.body && (
          <div className="mt-2">
            <p className={cn("text-sm break-words whitespace-pre-wrap text-muted-foreground", long && !expanded && "line-clamp-5")}>{a.body}</p>
            {long && (
              <button type="button" className="mt-1 text-xs font-medium text-primary hover:underline" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Added <LocalTime value={a.created_at} mode="ago" />
          </span>
          {a.due_at && (
            <span className={cn(overdue && "font-medium text-danger")}>
              {task ? "Due" : "Scheduled"} <LocalTime value={a.due_at} />
            </span>
          )}
          {a.completed_at && (
            <span>
              Completed <LocalTime value={a.completed_at} mode="ago" />
            </span>
          )}
          {dealTitle && <span>Deal: {dealTitle}</span>}
        </div>
      </div>
    </li>
  );
}

function LogActivityForm({ contactId, deals, onCreated }: { contactId: string; deals: Deal[]; onCreated: (a: Activity) => void }) {
  const idp = React.useId();
  const id = (k: string) => `${idp}-${k}`;
  const [type, setType] = React.useState<ActivityType>("note");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [due, setDue] = React.useState("");
  const [dealId, setDealId] = React.useState("");
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const showDue = type === "task" || type === "reminder" || type === "meeting" || type === "call";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!subject.trim()) {
      setErrors({ subject: "Subject is required." });
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ activity: Activity }>("/api/crm/activities", {
        method: "POST",
        json: {
          contact_id: contactId,
          deal_id: dealId || null,
          type,
          subject: subject.trim(),
          body: body.trim() || null,
          due_at: showDue ? localInputToIso(due) : null,
        },
      });
      onCreated(res.activity);
      setSubject("");
      setBody("");
      setDue("");
      setErrors({});
      toast(`${ACTIVITY_LABELS[type]} logged.`, "success");
    } catch (err) {
      const fe = toFieldErrors(err);
      setErrors(fe);
      setFormError(Object.keys(fe).some((k) => k !== "_form") ? "Please fix the highlighted fields." : (fe._form ?? errorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border bg-muted/30 p-3" aria-label="Log activity">
      <p className="text-sm font-medium">Log activity</p>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <FormField label="Type" htmlFor={id("type")} error={errors.type}>
          <Select {...fieldAria(id("type"), errors.type)} value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_LABELS[t]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Subject *" htmlFor={id("subject")} error={errors.subject}>
          <Input
            {...fieldAria(id("subject"), errors.subject)}
            value={subject}
            maxLength={300}
            placeholder={type === "task" ? "e.g. Send revised quote" : type === "call" ? "e.g. Intro call" : "Short summary"}
            onChange={(e) => {
              setSubject(e.target.value);
              if (errors.subject) setErrors((x) => ({ ...x, subject: "" }));
            }}
          />
        </FormField>
      </div>
      <FormField label="Details" htmlFor={id("body")} error={errors.body}>
        <Textarea {...fieldAria(id("body"), errors.body)} value={body} maxLength={10000} rows={3} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      {(showDue || deals.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {showDue && (
            <FormField label={type === "task" || type === "reminder" ? "Due" : "Scheduled for"} htmlFor={id("due")} error={errors.due_at}>
              <Input {...fieldAria(id("due"), errors.due_at)} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </FormField>
          )}
          {deals.length > 0 && (
            <FormField label="Related deal" htmlFor={id("deal")} error={errors.deal_id}>
              <Select {...fieldAria(id("deal"), errors.deal_id)} value={dealId} onChange={(e) => setDealId(e.target.value)}>
                <option value="">None</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={saving}>
          Log {ACTIVITY_LABELS[type].toLowerCase()}
        </Button>
      </div>
    </form>
  );
}
