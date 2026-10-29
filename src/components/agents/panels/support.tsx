"use client";

import * as React from "react";
import { AlertTriangle, BookOpen, FileText, MessageSquarePlus, MessagesSquare, Plus, RefreshCw, Send, Ticket, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Skeleton, Spinner, Textarea } from "@/components/ui";
import { Dialog, Tabs, toast } from "@/components/ui/client";
import { AiBadge } from "@/components/status";
import type { SupportResult } from "@/lib/agents/logic/support";
import { api, cn, formatDateTime, formatNumber, timeAgo } from "@/lib/utils";
import { startRun } from "../run-request";
import type { ExecutionDetail, InputPanelProps, ResultViewProps } from "../types";
import { ConfirmDialog, EMAIL_RE, errorMessage, FileInput, FormErrorAlert, type FormError, humanize, RunGate, toFormError, useApi } from "./shared";

/* ------------------------------------------------------------------ */
/* Types and shared bits                                               */
/* ------------------------------------------------------------------ */

type Citation = { document_id: string; title: string };
type Message = { role: "customer" | "assistant"; content: string; at: string; citations?: unknown; execution_id?: string; escalated?: boolean };
type ConvoStatus = "open" | "resolved" | "escalated" | "closed";
type Conversation = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  channel?: string | null;
  status: ConvoStatus;
  topic: string | null;
  urgency: string | null;
  messages: Message[];
  ticket_ref: string | null;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
};

const TERMINAL: ExecutionDetail["status"][] = ["succeeded", "failed", "timed_out", "cancelled", "awaiting_approval"];
const STATUS_TONE: Record<string, "neutral" | "primary" | "success" | "warning" | "danger"> = { open: "primary", escalated: "warning", resolved: "success", closed: "neutral" };
const URGENCY_TONE: Record<string, "neutral" | "primary" | "success" | "warning" | "danger"> = { low: "neutral", normal: "neutral", high: "warning", urgent: "danger" };

function citations(v: unknown): Citation[] {
  return Array.isArray(v) ? v.filter((c): c is Citation => Boolean(c) && typeof c === "object" && typeof (c as Citation).title === "string") : [];
}

function convoUrl(id: string | null) {
  return id ? `/api/support/conversations?id=${encodeURIComponent(id)}` : null;
}

function MessageList({ messages, typing, pending, className }: { messages: Message[]; typing?: boolean; pending?: string | null; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const count = messages.length;
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, typing, pending]);

  return (
    <div ref={ref} className={cn("flex flex-col gap-3 overflow-y-auto", className)} aria-live="polite">
      {messages.map((m, i) => (
        <Bubble key={`${m.at}-${i}`} message={m} />
      ))}
      {pending && <Bubble message={{ role: "customer", content: pending, at: "" }} pending />}
      {typing && (
        <div className="flex items-center gap-1.5 self-start rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5" aria-label="Assistant is typing">
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({ message, pending }: { message: Message; pending?: boolean }) {
  const mine = message.role === "customer";
  const cites = citations(message.citations);
  return (
    <div className={cn("flex max-w-[88%] flex-col gap-1", mine ? "items-end self-end" : "items-start self-start")}>
      <div className={cn("whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm", mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted text-foreground", pending && "opacity-60")}>
        {message.content}
      </div>
      {!mine && (cites.length > 0 || message.escalated) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {message.escalated && (
            <Badge tone="warning">
              <AlertTriangle className="size-3" aria-hidden /> Escalated to the team
            </Badge>
          )}
          {cites.map((c) => (
            <Badge key={c.document_id} tone="outline" className="font-normal">
              <BookOpen className="size-3" aria-hidden /> {c.title}
            </Badge>
          ))}
        </div>
      )}
      {message.at && <span className="text-[11px] text-muted-foreground">{pending ? "Sending…" : formatDateTime(message.at)}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Input: chat                                                         */
/* ------------------------------------------------------------------ */

export function SupportInputPanel({ canWrite, blockedReason, onStarted, current }: InputPanelProps) {
  const currentConvo =
    current?.agent_slug === "customer-support-agent" && typeof current.input_ref?.conversation_id === "string" ? (current.input_ref.conversation_id as string) : null;

  // Follow the selected execution's conversation; "New conversation" clears it locally.
  const [prevConvo, setPrevConvo] = React.useState(currentConvo);
  const [conversationId, setConversationId] = React.useState<string | null>(currentConvo);
  if (currentConvo !== prevConvo) {
    setPrevConvo(currentConvo);
    if (currentConvo) setConversationId(currentConvo);
  }

  const convo = useApi<{ conversation: Conversation }>(convoUrl(conversationId), `${current?.id ?? ""}:${current?.status ?? ""}`);
  const conversation = convo.data?.conversation ?? null;
  const messages = conversation?.messages ?? [];

  const [message, setMessage] = React.useState("");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);
  const [optimistic, setOptimistic] = React.useState<{ content: string; base: number } | null>(null);
  const [pendingExec, setPendingExec] = React.useState<string | null>(null);

  const disabled = !canWrite || Boolean(blockedReason) || submitting;
  const showOptimistic = optimistic && messages.length <= optimistic.base ? optimistic.content : null;

  const answered = pendingExec !== null && messages.some((m) => m.role === "assistant" && m.execution_id === pendingExec);
  const currentIsPending = pendingExec !== null && current?.id === pendingExec;
  const typing =
    conversationId !== null &&
    !answered &&
    ((pendingExec !== null && (!currentIsPending || !TERMINAL.includes(current!.status))) ||
      (current !== null && currentConvo === conversationId && (current.status === "queued" || current.status === "running")));

  const failedRun =
    current && currentConvo === conversationId && ["failed", "timed_out"].includes(current.status) && !messages.some((m) => m.role === "assistant" && m.execution_id === current.id)
      ? current
      : null;

  function newConversation() {
    setConversationId(null);
    setPendingExec(null);
    setOptimistic(null);
    setError(null);
    setMessage("");
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = message.trim();
    if (disabled || !text) return;
    if (!conversationId && email.trim() && !EMAIL_RE.test(email.trim())) return setError({ message: "Enter a valid customer email or leave it blank.", issues: [] });
    setError(null);
    setSubmitting(true);
    setOptimistic({ content: text, base: messages.length });
    setMessage("");
    try {
      const body: Record<string, unknown> = { message: text };
      if (conversationId) body.conversation_id = conversationId;
      else {
        if (name.trim()) body.customer_name = name.trim();
        if (email.trim()) body.customer_email = email.trim();
      }
      const execution = await startRun("customer-support-agent", body);
      const newConvo = typeof execution.input_ref?.conversation_id === "string" ? (execution.input_ref.conversation_id as string) : conversationId;
      setPendingExec(execution.id);
      if (newConvo !== conversationId) {
        setConversationId(newConvo);
        setOptimistic({ content: text, base: 0 });
      } else {
        convo.reload();
      }
      onStarted(execution);
    } catch (err) {
      setOptimistic(null);
      setMessage(text);
      setError(toFormError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <RunGate blockedReason={blockedReason} canWrite={canWrite} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          {conversationId ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{conversation?.customer_name || conversation?.customer_email || "Customer"}</span>
              {conversation && <Badge tone={STATUS_TONE[conversation.status] ?? "neutral"}>{humanize(conversation.status)}</Badge>}
              {conversation?.ticket_ref && (
                <Badge tone="outline">
                  <Ticket className="size-3" aria-hidden /> {conversation.ticket_ref}
                </Badge>
              )}
            </div>
          ) : (
            <span className="font-medium">New conversation</span>
          )}
        </div>
        {conversationId && (
          <Button size="sm" variant="outline" onClick={newConversation} disabled={submitting}>
            <MessageSquarePlus /> New conversation
          </Button>
        )}
      </div>

      {!conversationId && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input placeholder="Customer name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="Customer name" disabled={!canWrite} />
          <Input type="email" placeholder="Customer email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} aria-label="Customer email" disabled={!canWrite} />
        </div>
      )}

      <div className="rounded-lg border bg-card">
        {convo.loading && !conversation && conversationId ? (
          <div className="space-y-3 p-3">
            <Skeleton className="ml-auto h-9 w-2/3" />
            <Skeleton className="h-14 w-3/4" />
          </div>
        ) : convo.error && !conversation ? (
          <div className="p-3">
            <Alert tone="danger" title="Couldn't load the conversation" action={<Button size="sm" variant="outline" onClick={convo.reload}>Retry</Button>}>
              {convo.error}
            </Alert>
          </div>
        ) : messages.length === 0 && !showOptimistic ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 p-4 text-center">
            <MessagesSquare className="size-6 text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground">Type a customer question to test the assistant.</p>
          </div>
        ) : (
          <MessageList messages={messages} typing={typing} pending={showOptimistic} className="max-h-[26rem] min-h-40 p-3" />
        )}
        {messages.length === 0 && !showOptimistic && typing && <MessageList messages={[]} typing className="px-3 pb-3" />}

        <form onSubmit={send} className="flex items-end gap-2 border-t p-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder={canWrite ? "Write a message… (Enter to send, Shift+Enter for a new line)" : "View-only access"}
            aria-label="Message"
            disabled={!canWrite}
            className="block max-h-40 min-h-9 flex-1 resize-y bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
          />
          <Button type="submit" size="icon" disabled={disabled || !message.trim()} loading={submitting} aria-label="Send message">
            {!submitting && <Send />}
          </Button>
        </form>
      </div>

      {failedRun && (
        <Alert tone="danger" title="The assistant couldn't reply">
          {failedRun.error_message ?? "The run failed."} You can retry the run or send the message again.
        </Alert>
      )}
      <FormErrorAlert error={error} />
      <p className="text-xs text-muted-foreground">Answers come only from your approved knowledge base. Questions it can&apos;t answer are escalated to your team.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export function SupportResultView({ execution }: ResultViewProps) {
  const result = execution.result as SupportResult | null;
  const convoId = typeof execution.input_ref?.conversation_id === "string" ? (execution.input_ref.conversation_id as string) : null;
  const convo = useApi<{ conversation: Conversation }>(convoUrl(convoId), execution.status);
  if (!result || typeof result.reply !== "string") {
    return <EmptyState icon={MessagesSquare} title="No reply" description="This run didn't return a reply." />;
  }
  const c = convo.data?.conversation ?? null;
  const cites = citations(result.citations);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Fact label="Intent">{humanize(result.intent)}</Fact>
        <Fact label="Urgency">
          <Badge tone={URGENCY_TONE[result.urgency] ?? "neutral"}>{humanize(result.urgency)}</Badge>
        </Fact>
        <Fact label="Escalation">
          {result.escalate ? <Badge tone="warning">Escalated</Badge> : <Badge tone="success">Answered</Badge>}
        </Fact>
        <Fact label="Grounding">
          {result.grounded ? <Badge tone="success">From knowledge base</Badge> : <Badge tone="neutral">No matching content</Badge>}
        </Fact>
      </div>

      {result.escalate && (
        <Alert tone="warning" title="Handed to your team">
          {result.escalation_reason ?? "The assistant escalated this conversation."}
          {result.needs_contact_details ? " The customer hasn't shared an email yet, so the reply asks for contact details." : ""}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Reply sent to the customer</CardTitle>
            <span className="flex flex-wrap gap-2">
              {result.ai_generated ? <Badge tone="primary">AI-generated</Badge> : <Badge tone="neutral">{result.grounded ? "Knowledge-base excerpt" : "Standard reply"}</Badge>}
              <AiBadge status={execution.ai_status} />
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="whitespace-pre-wrap text-sm">{result.reply}</p>
          {cites.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Sources</span>
              {cites.map((ci) => (
                <Badge key={ci.document_id} tone="outline" className="font-normal">
                  <BookOpen className="size-3" aria-hidden /> {ci.title}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No knowledge-base sources were cited.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ticket</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!convoId ? (
            <p className="text-muted-foreground">No conversation linked to this run.</p>
          ) : convo.loading && !c ? (
            <Skeleton className="h-10" />
          ) : convo.error && !c ? (
            <p className="text-danger">{convo.error}</p>
          ) : c ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Ticket</dt>
                <dd className="font-medium">{c.ticket_ref ?? "None (not escalated)"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd>
                  <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{humanize(c.status)}</Badge>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Customer</dt>
                <dd className="truncate">{c.customer_name || c.customer_email || "Unknown"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Messages</dt>
                <dd className="tabular-nums">{c.messages?.length ?? 0}</dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1.5 text-sm font-medium">{children}</div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Extras: knowledge base + ticket queue                               */
/* ------------------------------------------------------------------ */

export function SupportExtras({ canWrite }: { canWrite: boolean; currency: string }) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <KnowledgeBase canWrite={canWrite} />
      <TicketQueue canWrite={canWrite} />
    </div>
  );
}

type KnowledgeDoc = {
  id: string;
  title: string;
  source_type: string;
  mime_type: string | null;
  size_bytes: number | null;
  status: string;
  chunk_count: number;
  approved: boolean;
  created_at: string;
};

function formatBytes(n: number | null) {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, 1)} KB`;
  return `${formatNumber(n / 1024 / 1024, 1)} MB`;
}

function KnowledgeBase({ canWrite }: { canWrite: boolean }) {
  const docs = useApi<{ documents: KnowledgeDoc[] }>("/api/knowledge");
  const [adding, setAdding] = React.useState(false);
  const [toDelete, setToDelete] = React.useState<KnowledgeDoc | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const list = docs.data?.documents ?? [];

  async function remove() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api(`/api/knowledge/${toDelete.id}`, { method: "DELETE" });
      docs.mutate((prev) => (prev ? { documents: prev.documents.filter((d) => d.id !== toDelete.id) } : prev));
      toast(`Deleted "${toDelete.title}".`, "success");
      setToDelete(null);
    } catch (err) {
      toast(errorMessage(err, "Could not delete the document."), "danger");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>Knowledge base</CardTitle>
            <p className="text-sm text-muted-foreground">The assistant only answers from these documents.</p>
          </div>
          {canWrite && !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add document
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <AddKnowledgeForm
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              docs.reload();
            }}
          />
        )}
        {docs.error && (
          <Alert tone="danger" title="Couldn't load documents" action={<Button size="sm" variant="outline" onClick={docs.reload}>Retry</Button>}>
            {docs.error}
          </Alert>
        )}
        {docs.loading && !docs.data && (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {docs.data && list.length === 0 && (
          <EmptyState icon={BookOpen} title="No documents yet" description="Add your FAQ, return policy or shipping info so the assistant can answer from it." />
        )}
        {list.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {list.map((d) => (
              <li key={d.id} className="flex items-center gap-3 p-3">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.source_type === "upload" ? "Uploaded file" : "Pasted text"} · {formatBytes(d.size_bytes)} · {d.chunk_count} section{d.chunk_count === 1 ? "" : "s"} · {timeAgo(d.created_at)}
                  </p>
                </div>
                {d.status !== "ready" && <Badge tone="warning">{humanize(d.status)}</Badge>}
                {!d.approved && <Badge tone="neutral">Not approved</Badge>}
                {canWrite && (
                  <Button size="icon" variant="ghost" onClick={() => setToDelete(d)} aria-label={`Delete ${d.title}`}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        busy={deleting}
        tone="danger"
        title="Delete document?"
        description={toDelete ? `"${toDelete.title}" will be removed and the assistant will stop using it. This can't be undone.` : undefined}
        confirmLabel="Delete"
      />
    </Card>
  );
}

function AddKnowledgeForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [mode, setMode] = React.useState<"text" | "file">("text");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<FormError | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const form = new FormData();
    if (mode === "file") {
      if (!file) return setError({ message: "Choose a .txt or .md file.", issues: [] });
      if (!/\.(txt|md|markdown)$/i.test(file.name)) return setError({ message: "Upload a .txt or .md file.", issues: [] });
      if (file.size > 1024 * 1024) return setError({ message: "Documents must be under 1 MB.", issues: [] });
      form.set("file", file);
      if (title.trim()) form.set("title", title.trim());
    } else {
      if (!title.trim()) return setError({ message: "Give the document a title.", issues: [] });
      if (!content.trim()) return setError({ message: "Paste the document text.", issues: [] });
      form.set("title", title.trim());
      form.set("content", content);
    }
    setSaving(true);
    try {
      const res = await api<{ id: string; chunks: number }>("/api/knowledge", { method: "POST", body: form });
      toast(`Added to the knowledge base (${res.chunks} section${res.chunks === 1 ? "" : "s"}).`, "success");
      onAdded();
    } catch (err) {
      setError(toFormError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border bg-muted/30 p-3" noValidate>
      <Tabs
        value={mode}
        onChange={(v) => {
          setMode(v);
          setError(null);
        }}
        tabs={[
          { value: "text", label: "Paste text" },
          { value: "file", label: "Upload file" },
        ]}
      />
      <Field label={mode === "file" ? "Title (optional)" : "Title"}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Return policy" />
      </Field>
      {mode === "text" ? (
        <Field label="Content">
          <Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} maxLength={200_000} placeholder="Paste the policy, FAQ or help text" />
        </Field>
      ) : (
        <Field label="File" hint=".txt or .md, up to 1 MB">
          <FileInput accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      <FormErrorAlert error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          Add document
        </Button>
      </div>
    </form>
  );
}

type QueueRow = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  status: ConvoStatus;
  topic: string | null;
  urgency: string | null;
  ticket_ref: string | null;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string | null;
};

function TicketQueue({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = React.useState<"escalated" | "open" | "resolved">("escalated");
  const queue = useApi<{ conversations: QueueRow[] }>(`/api/support/conversations?status=${status}`);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const rows = queue.data?.conversations ?? [];

  async function setConvoStatus(id: string, next: ConvoStatus) {
    setBusy(id);
    try {
      await api("/api/support/conversations", { method: "PATCH", json: { id, status: next } });
      queue.mutate((prev) => (prev ? { conversations: prev.conversations.filter((c) => c.id !== id) } : prev));
      toast(next === "resolved" ? "Marked as resolved." : "Reopened.", "success");
    } catch (err) {
      toast(errorMessage(err, "Could not update the conversation."), "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>Conversations</CardTitle>
            <p className="text-sm text-muted-foreground">Escalated questions wait here for a person.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={queue.reload} disabled={queue.loading} aria-label="Refresh conversations">
            <RefreshCw className={cn(queue.loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "escalated", label: "Escalated" },
            { value: "open", label: "Open" },
            { value: "resolved", label: "Resolved" },
          ]}
        />
        {queue.error && (
          <Alert tone="danger" title="Couldn't load conversations" action={<Button size="sm" variant="outline" onClick={queue.reload}>Retry</Button>}>
            {queue.error}
          </Alert>
        )}
        {queue.loading && !queue.data ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : queue.data && rows.length === 0 ? (
          <EmptyState icon={MessagesSquare} title={`No ${status} conversations`} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((c) => (
              <li key={c.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium">{c.customer_name || c.customer_email || "Anonymous customer"}</span>
                  {c.ticket_ref && <Badge tone="outline">{c.ticket_ref}</Badge>}
                  {c.topic && <Badge tone="neutral">{humanize(c.topic)}</Badge>}
                  {c.urgency && c.urgency !== "normal" && <Badge tone={URGENCY_TONE[c.urgency] ?? "neutral"}>{humanize(c.urgency)}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{timeAgo(c.updated_at)}</span>
                </div>
                {c.last_message && <p className="line-clamp-2 text-sm text-muted-foreground">{c.last_message}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setViewing(c.id)}>
                    View ({c.message_count})
                  </Button>
                  {canWrite && c.status !== "resolved" && (
                    <Button size="sm" variant="outline" onClick={() => setConvoStatus(c.id, "resolved")} loading={busy === c.id}>
                      Resolve
                    </Button>
                  )}
                  {canWrite && c.status === "resolved" && (
                    <Button size="sm" variant="ghost" onClick={() => setConvoStatus(c.id, "open")} loading={busy === c.id}>
                      Reopen
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConversationDialog id={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function ConversationDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const convo = useApi<{ conversation: Conversation }>(convoUrl(id));
  const c = convo.data?.conversation ?? null;
  return (
    <Dialog open={id !== null} onClose={onClose} title={c ? c.customer_name || c.customer_email || "Conversation" : "Conversation"} description={c ? [c.ticket_ref, c.customer_email, `Started ${formatDateTime(c.created_at)}`].filter(Boolean).join(" · ") : undefined}>
      {convo.loading && !c ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : convo.error ? (
        <Alert tone="danger">{convo.error}</Alert>
      ) : c ? (
        <MessageList messages={c.messages ?? []} />
      ) : null}
    </Dialog>
  );
}
