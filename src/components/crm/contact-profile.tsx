"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Briefcase, Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Select, Spinner } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { DemoBadge } from "@/components/status";
import { api, cn, formatCurrency } from "@/lib/utils";
import { ActivityTimeline } from "./activity-timeline";
import { CONTACT_STATUSES, DEAL_STAGES, STAGE_META, STATUS_META, contactPayload, type Activity, type Contact, type ContactStatus, type Deal, type DealStage } from "./constants";
import { ContactFormDialog } from "./contact-form-dialog";
import { formatDay } from "./dates";
import { DealFormDialog } from "./deal-form-dialog";
import { patchDealStage } from "./pipeline-tab";
import { ConfirmDialog, ConsentBadge, LeadScore, LocalTime, StatusBadge, errorMessage } from "./shared";

export type ContactDetail = { contact: Contact; deals: Deal[]; activities: Activity[] };

/** How long to wait before re-fetching so automation output (tasks, drafts) shows up. */
const AUTOMATION_REFRESH_MS = 8000;

export function ContactProfile({ initial, canWrite, currency }: { initial: ContactDetail; canWrite: boolean; currency: string }) {
  const router = useRouter();
  const [detail, setDetail] = React.useState(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<"edit" | "delete" | "deal" | null>(null);
  const [statusSaving, setStatusSaving] = React.useState(false);
  const [movingDeal, setMovingDeal] = React.useState<Record<string, boolean>>({});
  const { contact, deals, activities } = detail;
  const contactId = contact.id;

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api<ContactDetail>(`/api/crm/contacts/${contactId}`);
      setDetail(res);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [contactId]);

  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const refreshAfterAutomations = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), AUTOMATION_REFRESH_MS);
  };

  async function changeStatus(status: ContactStatus) {
    if (status === contact.status) return;
    setStatusSaving(true);
    try {
      const res = await api<{ contact: Contact }>(`/api/crm/contacts/${contact.id}`, { method: "PATCH", json: contactPayload(contact, { status }) });
      setDetail((d) => ({ ...d, contact: res.contact }));
      toast(`Status changed to ${STATUS_META[status].label}. Automations may add follow-ups shortly.`, "success");
      refreshAfterAutomations();
    } catch (err) {
      toast(`Couldn't change the status: ${errorMessage(err)}`, "danger");
    } finally {
      setStatusSaving(false);
    }
  }

  async function moveDeal(deal: Deal, stage: DealStage) {
    if (deal.stage === stage) return;
    const previous = deal.stage;
    const replace = (fn: (d: Deal) => Deal) => setDetail((cur) => ({ ...cur, deals: cur.deals.map((d) => (d.id === deal.id ? fn(d) : d)) }));
    replace((d) => ({ ...d, stage }));
    setMovingDeal((m) => ({ ...m, [deal.id]: true }));
    try {
      const res = await patchDealStage(deal, stage);
      replace(() => ({ ...res.deal }));
      toast(`“${deal.title}” moved to ${STAGE_META[stage].label}.`, "success");
      refreshAfterAutomations();
    } catch (err) {
      replace((d) => ({ ...d, stage: previous }));
      toast(`Couldn't move “${deal.title}”: ${errorMessage(err)}`, "danger");
    } finally {
      setMovingDeal((m) => {
        const next = { ...m };
        delete next[deal.id];
        return next;
      });
    }
  }

  async function deleteContact() {
    await api(`/api/crm/contacts/${contact.id}`, { method: "DELETE" });
    toast(`Deleted ${contact.name}.`, "success");
    router.push("/crm");
  }

  const details: { label: string; value: React.ReactNode }[] = [
    {
      label: "Email",
      value: contact.email ? (
        <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
          {contact.email}
        </a>
      ) : null,
    },
    {
      label: "Phone",
      value: contact.phone ? (
        <a href={`tel:${contact.phone}`} className="text-primary hover:underline">
          {contact.phone}
        </a>
      ) : null,
    },
    { label: "Company", value: contact.company },
    { label: "Source", value: contact.source },
    { label: "Industry", value: contact.industry },
    { label: "Location", value: contact.location },
    { label: "Company size", value: contact.company_size },
    {
      label: "Tags",
      value: contact.tags?.length ? (
        <span className="flex flex-wrap gap-1">
          {contact.tags.map((t) => (
            <Badge key={t} tone="outline">
              {t}
            </Badge>
          ))}
        </span>
      ) : null,
    },
    { label: "Created", value: <LocalTime value={contact.created_at} /> },
    { label: "Last updated", value: <LocalTime value={contact.updated_at} /> },
  ];

  return (
    <div className="space-y-6">
      <Link href="/crm" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Back to CRM
      </Link>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words">{contact.name}</h1>
            {contact.is_demo && <DemoBadge />}
          </div>
          {(contact.company || contact.email) && (
            <p className="text-sm break-words text-muted-foreground">{[contact.company, contact.email].filter(Boolean).join(" · ")}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={contact.status} />
            <ConsentBadge consent={contact.consent_status} />
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              Lead score <LeadScore score={contact.lead_score} className="text-sm text-foreground" />
            </span>
          </div>
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor="contact-status" className="text-sm text-muted-foreground">
                Status
              </label>
              <Select id="contact-status" value={contact.status} disabled={statusSaving} onChange={(e) => changeStatus(e.target.value as ContactStatus)} className="w-36">
                {CONTACT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </Select>
              {statusSaving && <Spinner />}
            </div>
            <Button variant="outline" onClick={() => setDialog("edit")}>
              <Pencil aria-hidden />
              Edit
            </Button>
            <Button variant="outline" className="text-danger hover:text-danger" onClick={() => setDialog("delete")}>
              <Trash2 aria-hidden />
              Delete
            </Button>
          </div>
        )}
      </div>

      {refreshError && (
        <Alert
          tone="warning"
          title="Couldn't refresh this contact"
          action={
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {refreshError}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {details.map((d) => (
                  <div key={d.label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{d.label}</dt>
                    <dd className="text-sm break-words">{d.value ?? <span className="text-muted-foreground">—</span>}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>Deals</CardTitle>
                <CardDescription>
                  {deals.length} {deals.length === 1 ? "deal" : "deals"} · {formatCurrency(deals.reduce((s, d) => s + Number(d.value || 0), 0), currency)}
                </CardDescription>
              </div>
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setDialog("deal")}>
                  <Plus aria-hidden />
                  Add deal
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {deals.length === 0 ? (
                <EmptyState icon={Briefcase} title="No deals yet" className="py-6" />
              ) : (
                <ul className="divide-y rounded-md border">
                  {deals.map((d) => (
                    <li key={d.id} className="space-y-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 text-sm font-medium break-words">{d.title}</p>
                        {d.is_demo && <DemoBadge />}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-semibold text-foreground tabular-nums">{formatCurrency(d.value, d.currency)}</span>
                        {d.expected_close_date && <span>Closes {formatDay(d.expected_close_date)}</span>}
                      </div>
                      {canWrite ? (
                        <div className="flex items-center gap-2">
                          <label htmlFor={`deal-stage-${d.id}`} className="text-xs text-muted-foreground">
                            Stage
                          </label>
                          <Select
                            id={`deal-stage-${d.id}`}
                            value={d.stage}
                            disabled={!!movingDeal[d.id]}
                            onChange={(e) => moveDeal(d, e.target.value as DealStage)}
                            className={cn("h-8 flex-1 text-xs")}
                          >
                            {DEAL_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_META[s].label}
                              </option>
                            ))}
                          </Select>
                          {movingDeal[d.id] && <Spinner />}
                        </div>
                      ) : (
                        <Badge tone={STAGE_META[d.stage]?.tone ?? "neutral"}>{STAGE_META[d.stage]?.label ?? d.stage}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <ActivityTimeline
            contactId={contact.id}
            deals={deals}
            activities={activities}
            canWrite={canWrite}
            setActivities={(fn) => setDetail((d) => ({ ...d, activities: fn(d.activities) }))}
            onRefresh={() => void refresh()}
            refreshing={refreshing}
          />
        </div>
      </div>

      {canWrite && (
        <>
          <ContactFormDialog
            open={dialog === "edit"}
            onClose={() => setDialog(null)}
            contact={contact}
            onSaved={(c) => {
              const statusChanged = c.status !== contact.status;
              setDialog(null);
              setDetail((d) => ({ ...d, contact: c }));
              toast(statusChanged ? "Contact saved. Automations may add follow-ups shortly." : "Contact saved.", "success");
              if (statusChanged) refreshAfterAutomations();
            }}
          />
          <DealFormDialog
            open={dialog === "deal"}
            onClose={() => setDialog(null)}
            currency={currency}
            fixedContact={{ id: contact.id, name: contact.name }}
            onCreated={(deal) => {
              setDialog(null);
              setDetail((d) => ({ ...d, deals: [deal, ...d.deals] }));
              toast(`Deal “${deal.title}” created. Automations will follow up.`, "success");
              refreshAfterAutomations();
            }}
          />
          <ConfirmDialog open={dialog === "delete"} onClose={() => setDialog(null)} title={`Delete ${contact.name}?`} confirmLabel="Delete contact" onConfirm={deleteContact}>
            This permanently deletes the contact together with their deals and activity history. This can&apos;t be undone.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}
