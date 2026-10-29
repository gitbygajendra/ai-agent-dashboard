"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, ListTodo, Plus, User } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Input, Select, Skeleton, Spinner, Textarea } from "@/components/ui";
import { Dialog, toast } from "@/components/ui/client";
import { api, cn } from "@/lib/utils";
import type { Activity, OpenTask } from "./constants";
import { ContactPicker, type PickedContact } from "./contact-picker";
import { dueBucket, localInputToIso, type DueBucket } from "./dates";
import { useFetch } from "./hooks";
import { AutomationBadge, FormField, LocalTime, errorMessage, fieldAria, toFieldErrors, type FieldErrors } from "./shared";

const BUCKETS: { key: DueBucket; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "none", label: "No due date" },
];

export function TasksTab({ canWrite, refreshKey }: { canWrite: boolean; refreshKey: number }) {
  const { data, error, loading, reload, mutate } = useFetch<{ tasks: OpenTask[] }>("/api/crm/tasks?limit=200", refreshKey);
  const [completing, setCompleting] = React.useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = React.useState(false);

  async function complete(task: OpenTask) {
    setCompleting((c) => ({ ...c, [task.id]: true }));
    try {
      await api(`/api/crm/activities/${task.id}`, { method: "PATCH", json: { completed: true } });
      mutate((cur) => cur && { tasks: cur.tasks.filter((t) => t.id !== task.id) });
      toast(`Completed “${task.subject}”.`, "success");
    } catch (err) {
      toast(`Couldn't complete the task: ${errorMessage(err)}`, "danger");
    } finally {
      setCompleting((c) => {
        const next = { ...c };
        delete next[task.id];
        return next;
      });
    }
  }

  const tasks = data?.tasks ?? [];
  const groups = BUCKETS.map((b) => ({ ...b, tasks: tasks.filter((t) => dueBucket(t.due_at) === b.key) })).filter((g) => g.tasks.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Open tasks and reminders across all contacts. Automations add follow-ups here when leads and deals change.
          {loading && data && <Spinner />}
        </p>
        {canWrite && (
          <Button onClick={() => setAddOpen(true)} className="self-start sm:self-auto">
            <Plus aria-hidden />
            Add task
          </Button>
        )}
      </div>

      {error && (
        <Alert
          tone="danger"
          title="Couldn't load tasks"
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {!data && loading ? (
        <Card className="space-y-3 p-4" aria-busy="true" aria-label="Loading tasks">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </Card>
      ) : data && tasks.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="You're all caught up" description="No open tasks or reminders. New follow-ups from automations will appear here." />
      ) : (
        groups.map((g) => (
          <Card key={g.key} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2">
              <h3 className={cn("text-sm font-semibold", g.key === "overdue" && "text-danger")}>{g.label}</h3>
              <Badge tone={g.key === "overdue" ? "danger" : "neutral"}>{g.tasks.length}</Badge>
            </div>
            <ul className="divide-y">
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} overdue={g.key === "overdue"} canWrite={canWrite} busy={!!completing[t.id]} onComplete={() => complete(t)} />
              ))}
            </ul>
          </Card>
        ))
      )}

      {canWrite && (
        <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add task" description="Tasks belong to a contact and show up on their timeline.">
          <AddTaskForm
            onCancel={() => setAddOpen(false)}
            onCreated={(a, contact) => {
              setAddOpen(false);
              mutate((cur) => cur && { tasks: [...cur.tasks, { ...a, contact_name: contact.name }].sort(byDue) });
              toast("Task added.", "success");
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

function byDue(a: Activity, b: Activity) {
  if (!a.due_at) return b.due_at ? 1 : 0;
  if (!b.due_at) return -1;
  return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
}

function TaskRow({ task, overdue, canWrite, busy, onComplete }: { task: OpenTask; overdue: boolean; canWrite: boolean; busy: boolean; onComplete: () => void }) {
  const id = React.useId();
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="flex h-5 items-center">
        {busy ? (
          <Spinner />
        ) : (
          <input
            id={id}
            type="checkbox"
            className="size-4 rounded border-input accent-primary"
            checked={false}
            disabled={!canWrite}
            onChange={onComplete}
            aria-label={`Mark “${task.subject}” complete`}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className={cn("text-sm font-medium break-words", busy && "text-muted-foreground line-through")}>
            {task.subject}
          </label>
          {task.type === "reminder" && <Badge tone="neutral">Reminder</Badge>}
          {task.execution_id && <AutomationBadge />}
        </div>
        {task.body && <p className="line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">{task.body}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-danger")}>
            <CalendarClock className="size-3.5" aria-hidden />
            {task.due_at ? (
              <>
                {overdue ? "Overdue · " : "Due "}
                <LocalTime value={task.due_at} />
              </>
            ) : (
              "No due date"
            )}
          </span>
          {task.contact_id && (
            <Link href={`/crm/contacts/${task.contact_id}`} className="inline-flex items-center gap-1 hover:text-primary hover:underline">
              <User className="size-3.5" aria-hidden />
              {task.contact_name ?? "View contact"}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

function AddTaskForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (a: Activity, contact: PickedContact) => void }) {
  const idp = React.useId();
  const id = (k: string) => `${idp}-${k}`;
  const [contact, setContact] = React.useState<PickedContact | null>(null);
  const [type, setType] = React.useState<"task" | "reminder">("task");
  const [subject, setSubject] = React.useState("");
  const [due, setDue] = React.useState("");
  const [body, setBody] = React.useState("");
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const local: FieldErrors = {};
    if (!contact) local.contact_id = "Choose a contact.";
    if (!subject.trim()) local.subject = "Subject is required.";
    if (Object.keys(local).length || !contact) {
      setErrors(local);
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ activity: Activity }>("/api/crm/activities", {
        method: "POST",
        json: { contact_id: contact.id, type, subject: subject.trim(), body: body.trim() || null, due_at: localInputToIso(due) },
      });
      onCreated(res.activity, contact);
    } catch (err) {
      const fe = toFieldErrors(err);
      setErrors(fe);
      setFormError(Object.keys(fe).some((k) => k !== "_form") ? "Please fix the highlighted fields." : (fe._form ?? errorMessage(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {formError && <Alert tone="danger">{formError}</Alert>}
      <FormField label="Contact *" htmlFor={id("contact")} error={errors.contact_id}>
        <ContactPicker
          id={id("contact")}
          value={contact}
          onChange={(c) => {
            setContact(c);
            setErrors((e) => ({ ...e, contact_id: "" }));
          }}
          allowNone={false}
          invalid={!!errors.contact_id}
          describedBy={errors.contact_id ? `${id("contact")}-error` : undefined}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Type" htmlFor={id("type")}>
          <Select id={id("type")} value={type} onChange={(e) => setType(e.target.value as "task" | "reminder")}>
            <option value="task">Task</option>
            <option value="reminder">Reminder</option>
          </Select>
        </FormField>
        <FormField label="Due" htmlFor={id("due")} error={errors.due_at}>
          <Input {...fieldAria(id("due"), errors.due_at)} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Subject *" htmlFor={id("subject")} error={errors.subject}>
        <Input {...fieldAria(id("subject"), errors.subject)} value={subject} maxLength={300} placeholder="e.g. Send revised quote" onChange={(e) => setSubject(e.target.value)} />
      </FormField>
      <FormField label="Details" htmlFor={id("body")} error={errors.body}>
        <Textarea {...fieldAria(id("body"), errors.body)} value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {!saving && <ListTodo aria-hidden />}
          Add task
        </Button>
      </div>
    </form>
  );
}
