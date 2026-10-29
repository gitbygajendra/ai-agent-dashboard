"use client";

import * as React from "react";
import { Input, Select, Spinner } from "@/components/ui";
import type { ContactListResponse } from "./constants";
import { useDebounced, useFetch } from "./hooks";

export type PickedContact = { id: string; name: string };

/** Search-as-you-type contact selector built on a native <select> (keyboard and mobile friendly). */
export function ContactPicker({
  id,
  value,
  onChange,
  allowNone = true,
  invalid,
  describedBy,
}: {
  id: string;
  value: PickedContact | null;
  onChange: (v: PickedContact | null) => void;
  allowNone?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [q, setQ] = React.useState("");
  const dq = useDebounced(q.trim(), 250);
  const params = new URLSearchParams({ limit: "50", sort: "name", dir: "asc" });
  if (dq) params.set("q", dq);
  const { data, loading, error } = useFetch<ContactListResponse>(`/api/crm/contacts?${params}`);
  const options = data?.contacts ?? [];
  const selectedListed = value ? options.some((o) => o.id === value.id) : true;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Input type="search" placeholder="Search contacts…" aria-label="Search contacts" aria-controls={id} value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && <Spinner className="absolute top-2.5 right-2.5" />}
      </div>
      <Select
        id={id}
        value={value?.id ?? ""}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return onChange(null);
          const c = options.find((o) => o.id === v);
          onChange(c ? { id: c.id, name: c.name } : value);
        }}
      >
        <option value="">{allowNone ? "No contact" : "Select a contact…"}</option>
        {value && !selectedListed && <option value={value.id}>{value.name}</option>}
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.company ? ` — ${c.company}` : ""}
          </option>
        ))}
      </Select>
      {error && <p className="text-xs text-danger">Couldn&apos;t load contacts: {error}</p>}
      {data && data.total > options.length && <p className="text-xs text-muted-foreground">Showing the first {options.length} matches — type to narrow down.</p>}
      {data && data.total === 0 && <p className="text-xs text-muted-foreground">{dq ? "No contacts match that search." : "No contacts yet."}</p>}
    </div>
  );
}
