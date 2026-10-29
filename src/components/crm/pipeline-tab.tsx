"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, GripVertical, KanbanSquare, Plus, Trash2, User } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Select, Skeleton, Spinner } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { DemoBadge } from "@/components/status";
import { api, cn, formatCurrency } from "@/lib/utils";
import { DEAL_STAGES, STAGE_META, type Deal, type DealStage } from "./constants";
import { DealFormDialog } from "./deal-form-dialog";
import { formatDay } from "./dates";
import { useFetch } from "./hooks";
import { ConfirmDialog, errorMessage } from "./shared";

type DealsResponse = { deals: Deal[] };

/** PATCH a deal's stage. `value` is resent because the server's partial schema would otherwise default it to 0. */
export async function patchDealStage(deal: Deal, stage: DealStage) {
  return api<{ deal: Deal }>(`/api/crm/deals/${deal.id}`, { method: "PATCH", json: { stage, value: deal.value } });
}

export function PipelineTab({ canWrite, currency, refreshKey }: { canWrite: boolean; currency: string; refreshKey: number }) {
  const { data, error, loading, reload, mutate } = useFetch<DealsResponse>("/api/crm/deals", refreshKey);
  const [newOpen, setNewOpen] = React.useState(false);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<DealStage | null>(null);
  const [moving, setMoving] = React.useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = React.useState<Deal | null>(null);

  const deals = React.useMemo(() => data?.deals ?? [], [data]);
  const byStage = React.useMemo(() => {
    const map = Object.fromEntries(DEAL_STAGES.map((s) => [s, [] as Deal[]])) as Record<DealStage, Deal[]>;
    for (const d of deals) (map[d.stage] ?? map.new).push(d);
    return map;
  }, [deals]);

  const replaceDeal = (id: string, fn: (d: Deal) => Deal) => mutate((cur) => cur && { deals: cur.deals.map((d) => (d.id === id ? fn(d) : d)) });

  async function moveDeal(deal: Deal, stage: DealStage) {
    if (!canWrite || deal.stage === stage || moving[deal.id]) return;
    const previous = deal.stage;
    replaceDeal(deal.id, (d) => ({ ...d, stage }));
    setMoving((m) => ({ ...m, [deal.id]: true }));
    try {
      const res = await patchDealStage(deal, stage);
      replaceDeal(deal.id, () => res.deal);
      toast(`“${deal.title}” moved to ${STAGE_META[stage].label}.`, "success");
    } catch (err) {
      replaceDeal(deal.id, (d) => ({ ...d, stage: previous }));
      toast(`Couldn't move “${deal.title}”: ${errorMessage(err)}`, "danger");
    } finally {
      setMoving((m) => {
        const next = { ...m };
        delete next[deal.id];
        return next;
      });
    }
  }

  async function deleteDeal(deal: Deal) {
    await api(`/api/crm/deals/${deal.id}`, { method: "DELETE" });
    mutate((cur) => cur && { deals: cur.deals.filter((d) => d.id !== deal.id) });
    toast(`Deleted “${deal.title}”.`, "success");
  }

  function onDrop(e: React.DragEvent, stage: DealStage) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setOverStage(null);
    setDragId(null);
    const deal = deals.find((d) => d.id === id);
    if (deal) void moveDeal(deal, stage);
  }

  const openValue = deals.filter((d) => d.stage !== "won" && d.stage !== "lost").reduce((s, d) => s + Number(d.value || 0), 0);
  const wonValue = byStage.won.reduce((s, d) => s + Number(d.value || 0), 0);

  if (!data && loading) {
    return (
      <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading pipeline">
        {DEAL_STAGES.slice(0, 4).map((s) => (
          <Skeleton key={s} className="h-80 w-72 shrink-0" />
        ))}
      </div>
    );
  }

  if (!data && error) {
    return (
      <Alert
        tone="danger"
        title="Couldn't load the pipeline"
        action={
          <Button size="sm" variant="outline" onClick={reload}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            Open pipeline <span className="font-medium text-foreground tabular-nums">{formatCurrency(openValue, currency)}</span>
          </span>
          <span>
            Won <span className="font-medium text-success tabular-nums">{formatCurrency(wonValue, currency)}</span>
          </span>
          {loading && <Spinner />}
        </div>
        {canWrite && (
          <Button onClick={() => setNewOpen(true)} className="self-start sm:self-auto">
            <Plus aria-hidden />
            New deal
          </Button>
        )}
      </div>
      {canWrite && deals.length > 0 && (
        <p className="text-xs text-muted-foreground">Drag cards between columns or use the stage menu on each card. Automations run when a deal changes stage.</p>
      )}

      {error && (
        <Alert tone="danger" title="Couldn't refresh the pipeline" action={<Button size="sm" variant="outline" onClick={reload}>Retry</Button>}>
          {error}
        </Alert>
      )}

      {deals.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="No deals yet"
          description={canWrite ? "Create a deal to start tracking your pipeline, or load demo data from the header." : "Deals your team creates will show up here."}
          action={
            canWrite && (
              <Button onClick={() => setNewOpen(true)}>
                <Plus aria-hidden />
                New deal
              </Button>
            )
          }
        />
      ) : (
        <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-3">
          {DEAL_STAGES.map((stage) => {
            const list = byStage[stage];
            const total = list.reduce((s, d) => s + Number(d.value || 0), 0);
            const isOver = overStage === stage && dragId !== null;
            return (
              <section
                key={stage}
                aria-label={`${STAGE_META[stage].label}: ${list.length} ${list.length === 1 ? "deal" : "deals"}`}
                className={cn(
                  "flex w-72 shrink-0 snap-start flex-col rounded-lg border bg-muted/40 transition-colors",
                  isOver && "border-primary/50 bg-primary-soft",
                )}
                onDragOver={(e) => {
                  if (!canWrite || !dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overStage !== stage) setOverStage(stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverStage((s) => (s === stage ? null : s));
                }}
                onDrop={(e) => onDrop(e, stage)}
              >
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{STAGE_META[stage].label}</h3>
                    <Badge tone={STAGE_META[stage].tone}>{list.length}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums" title={formatCurrency(total, currency)}>
                    {formatCurrency(total, currency, true)}
                  </span>
                </header>
                <div className="flex min-h-28 flex-1 flex-col gap-2 p-2">
                  {list.length === 0 && (
                    <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{isOver ? "Drop here" : "No deals"}</p>
                  )}
                  {list.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      canWrite={canWrite}
                      busy={!!moving[deal.id]}
                      dragging={dragId === deal.id}
                      onMove={(s) => moveDeal(deal, s)}
                      onDelete={() => setToDelete(deal)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", deal.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(deal.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverStage(null);
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {canWrite && (
        <DealFormDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          currency={currency}
          onCreated={(deal) => {
            setNewOpen(false);
            mutate((cur) => ({ deals: [deal, ...(cur?.deals ?? [])] }));
            toast(`Deal “${deal.title}” created. Automations will follow up.`, "success");
          }}
        />
      )}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} title="Delete deal?" onConfirm={() => (toDelete ? deleteDeal(toDelete) : Promise.resolve())}>
        “{toDelete?.title}” will be permanently deleted. This can&apos;t be undone.
      </ConfirmDialog>
    </div>
  );
}

function DealCard({
  deal,
  canWrite,
  busy,
  dragging,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  deal: Deal;
  canWrite: boolean;
  busy: boolean;
  dragging: boolean;
  onMove: (s: DealStage) => void;
  onDelete: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const selectId = React.useId();
  return (
    <Card
      draggable={canWrite && !busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn("space-y-2 p-3", canWrite && "cursor-grab active:cursor-grabbing", dragging && "opacity-50", busy && "opacity-70")}
    >
      <div className="flex items-start gap-1.5">
        {canWrite && <GripVertical className="mt-0.5 hidden size-4 shrink-0 text-muted-foreground/60 md:block" aria-hidden />}
        <p className="min-w-0 flex-1 text-sm leading-snug font-medium break-words">{deal.title}</p>
        {busy && <Spinner className="mt-0.5" />}
        {canWrite && (
          <button
            type="button"
            onClick={onDelete}
            className="-m-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
            aria-label={`Delete deal ${deal.title}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {deal.is_demo && <DemoBadge />}
      <div className="space-y-1 text-xs text-muted-foreground">
        {deal.contact_id ? (
          <Link href={`/crm/contacts/${deal.contact_id}`} className="flex items-center gap-1.5 hover:text-primary hover:underline" draggable={false}>
            <User className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{deal.contact_name ?? "View contact"}</span>
          </Link>
        ) : (
          <p className="flex items-center gap-1.5">
            <User className="size-3.5 shrink-0" aria-hidden />
            No contact
          </p>
        )}
        {deal.expected_close_date && (
          <p className="flex items-center gap-1.5">
            <CalendarDays className="size-3.5 shrink-0" aria-hidden />
            Closes {formatDay(deal.expected_close_date)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">{formatCurrency(deal.value, deal.currency)}</span>
        {canWrite ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              Stage for {deal.title}
            </label>
            <Select id={selectId} value={deal.stage} disabled={busy} onChange={(e) => onMove(e.target.value as DealStage)} className="h-7 w-32 px-2 text-xs">
              {DEAL_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_META[s].label}
                </option>
              ))}
            </Select>
          </>
        ) : (
          <Badge tone={STAGE_META[deal.stage]?.tone ?? "neutral"}>{STAGE_META[deal.stage]?.label ?? deal.stage}</Badge>
        )}
      </div>
    </Card>
  );
}
