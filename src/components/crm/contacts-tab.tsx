"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, Upload, UserPlus, Users, X } from "lucide-react";
import { Alert, Button, Card, EmptyState, Input, Select, Skeleton, Spinner, TBody, TD, TH, THead, TR, Table } from "@/components/ui";
import { DemoBadge } from "@/components/status";
import { cn, formatNumber } from "@/lib/utils";
import { CONTACT_STATUSES, STATUS_META, type ContactListResponse } from "./constants";
import { useDebounced, useFetch } from "./hooks";
import { LeadScore, LocalTime, StatusBadge } from "./shared";

const PAGE_SIZE = 50;
type SortKey = "name" | "company" | "lead_score" | "created_at";
type Dir = "asc" | "desc";
const DEFAULT_DIR: Record<SortKey, Dir> = { name: "asc", company: "asc", lead_score: "desc", created_at: "desc" };

export function ContactsTab({
  canWrite,
  refreshKey,
  onAddContact,
  onImport,
  onLoadDemo,
  demoBusy,
}: {
  canWrite: boolean;
  refreshKey: number;
  onAddContact: () => void;
  onImport: () => void;
  onLoadDemo: () => void;
  demoBusy: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const dq = useDebounced(q.trim(), 300);
  const [status, setStatus] = React.useState("");
  const [source, setSource] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("created_at");
  const [dir, setDir] = React.useState<Dir>("desc");
  const [offset, setOffset] = React.useState(0);

  // Reset to the first page whenever the (debounced) search changes.
  const [lastDq, setLastDq] = React.useState(dq);
  if (lastDq !== dq) {
    setLastDq(dq);
    setOffset(0);
  }

  const params = new URLSearchParams({ sort, dir, limit: String(PAGE_SIZE), offset: String(offset) });
  if (dq) params.set("q", dq);
  if (status) params.set("status", status);
  if (source) params.set("source", source);
  const { data, error, loading, reload } = useFetch<ContactListResponse>(`/api/crm/contacts?${params}`, refreshKey);

  const filtered = Boolean(dq || status || source);
  const clearFilters = () => {
    setQ("");
    setStatus("");
    setSource("");
    setOffset(0);
  };

  function toggleSort(key: SortKey) {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(DEFAULT_DIR[key]);
    }
    setOffset(0);
  }

  const sources = data?.sources ?? [];
  const total = data?.total ?? 0;
  const contacts = data?.contacts ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  // Unfiltered and empty → onboarding empty state.
  if (data && total === 0 && !filtered && !loading) {
    return (
      <EmptyState
        icon={Users}
        title="No contacts yet"
        description={
          canWrite
            ? "Add your first contact, import a spreadsheet, or load clearly labeled demo data to explore. Automations run when leads and deals change."
            : "Your workspace doesn't have any contacts yet. Ask a member to add or import some."
        }
        action={
          canWrite && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onAddContact}>
                <UserPlus aria-hidden />
                Add contact
              </Button>
              <Button variant="outline" onClick={onImport}>
                <Upload aria-hidden />
                Import CSV
              </Button>
              <Button variant="ghost" onClick={onLoadDemo} loading={demoBusy}>
                Load demo data
              </Button>
            </div>
          )
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or company" aria-label="Search contacts" className="pl-9" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            className="sm:w-40"
          >
            <option value="">All statuses</option>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setOffset(0);
            }}
            className="sm:w-44"
          >
            <option value="">All sources</option>
            {source && !sources.includes(source) && <option value={source}>{source}</option>}
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="self-start sm:self-auto">
            <X aria-hidden />
            Clear filters
          </Button>
        )}
        <div className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
          {loading && data && <Spinner />}
          {data && (
            <span aria-live="polite">
              {formatNumber(total)} {total === 1 ? "contact" : "contacts"}
            </span>
          )}
        </div>
      </div>

      {error && (
        <Alert
          tone="danger"
          title="Couldn't load contacts"
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {(!data || (total === 0 && !filtered)) && loading ? (
        <Card className="space-y-3 p-4" aria-busy="true" aria-label="Loading contacts">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </Card>
      ) : data && total === 0 ? (
        <EmptyState
          icon={Search}
          title="No contacts match your filters"
          action={
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : data ? (
        <Card className={cn("overflow-hidden", loading && "opacity-70 transition-opacity")}>
          <Table className="min-w-[760px]">
            <THead>
              <tr>
                <SortHeader label="Name" k="name" sort={sort} dir={dir} onSort={toggleSort} />
                <SortHeader label="Company" k="company" sort={sort} dir={dir} onSort={toggleSort} />
                <TH>Status</TH>
                <TH>Source</TH>
                <SortHeader label="Lead score" k="lead_score" sort={sort} dir={dir} onSort={toggleSort} />
                <SortHeader label="Created" k="created_at" sort={sort} dir={dir} onSort={toggleSort} />
              </tr>
            </THead>
            <TBody>
              {contacts.map((c) => (
                <TR
                  key={c.id}
                  className="cursor-pointer"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    router.push(`/crm/contacts/${c.id}`);
                  }}
                >
                  <TD className="max-w-64">
                    <div className="flex items-center gap-2">
                      <Link href={`/crm/contacts/${c.id}`} className="truncate font-medium hover:text-primary hover:underline">
                        {c.name}
                      </Link>
                      {c.is_demo && <DemoBadge />}
                    </div>
                    {c.email && <p className="truncate text-xs text-muted-foreground">{c.email}</p>}
                  </TD>
                  <TD className="max-w-48 truncate">{c.company ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD>
                    <StatusBadge status={c.status} />
                  </TD>
                  <TD className="max-w-40 truncate text-muted-foreground">{c.source ?? "—"}</TD>
                  <TD>
                    <LeadScore score={c.lead_score} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    <LocalTime value={c.created_at} mode="date" />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft aria-hidden />
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next
                <ChevronRight aria-hidden />
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function SortHeader({ label, k, sort, dir, onSort }: { label: string; k: SortKey; sort: SortKey; dir: Dir; onSort: (k: SortKey) => void }) {
  const active = sort === k;
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TH aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(k)} className={cn("-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground", active && "text-foreground")}>
        {label}
        <Icon className="size-3.5" aria-hidden />
      </button>
    </TH>
  );
}
