"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { AGENT_SLUGS, AGENTS, type AgentSlug } from "@/lib/agents/registry";
import { api } from "@/lib/utils";

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD"];
const EMAIL_CATEGORIES = [
  { value: "scheduling", label: "Scheduling" },
  { value: "customer_inquiry", label: "Customer inquiries" },
  { value: "support", label: "Support" },
  { value: "sales_lead", label: "Sales leads" },
  { value: "billing", label: "Billing" },
  { value: "internal", label: "Internal" },
  { value: "other", label: "Other" },
];

export function OrganizationForm({ name, currency, canEdit }: { name: string; currency: string; canEdit: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState({ name, currency });
  const [saving, setSaving] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/settings", { method: "PATCH", json: { organization: values } });
      toast("Workspace saved", "success");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>Name and the currency used for deals and financial figures.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-[1fr_160px_auto] sm:items-end">
          <Field label="Workspace name">
            <Input value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} disabled={!canEdit} maxLength={120} required />
          </Field>
          <Field label="Currency">
            <Select value={values.currency} onChange={(e) => setValues((v) => ({ ...v, currency: e.target.value }))} disabled={!canEdit}>
              {[...new Set([values.currency, ...CURRENCIES])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={saving} disabled={!canEdit}>
            Save
          </Button>
        </form>
        {!canEdit && <p className="mt-3 text-xs text-muted-foreground">Only owners and admins can change workspace settings.</p>}
      </CardContent>
    </Card>
  );
}

export function AgentSettingsForm({
  agents,
  autoSend,
  canEdit,
}: {
  agents: { slug: AgentSlug; enabled: boolean }[];
  autoSend: { enabled: boolean; categories: string[] };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState<Record<string, boolean>>(Object.fromEntries(agents.map((a) => [a.slug, a.enabled])));
  const [rule, setRule] = useState(autoSend);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (rule.enabled && rule.categories.length && !confirm(`Emails in ${rule.categories.length} categor${rule.categories.length > 1 ? "ies" : "y"} will be sent automatically without review. Continue?`)) return;
    setSaving(true);
    try {
      await api("/api/settings", {
        method: "PATCH",
        json: {
          agents: AGENT_SLUGS.map((slug) => ({
            slug,
            enabled: enabled[slug],
            ...(slug === "email-automation-agent" ? { auto_send: rule } : {}),
          })),
        },
      });
      toast("Agent settings saved", "success");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents & automation rules</CardTitle>
        <CardDescription>Turn agents on or off for this workspace. Turned-off agents can&apos;t be run and CRM events skip them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="divide-y rounded-md border">
          {AGENT_SLUGS.map((slug) => (
            <li key={slug} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{AGENTS[slug].name}</p>
                <p className="text-xs text-muted-foreground">{AGENTS[slug].implementationNote}</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={enabled[slug]}
                  disabled={!canEdit}
                  onChange={(e) => setEnabled((v) => ({ ...v, [slug]: e.target.checked }))}
                />
                <span className="sr-only">Enable {AGENTS[slug].name}</span>
                {enabled[slug] ? "On" : "Off"}
              </label>
            </li>
          ))}
        </ul>

        <div className="space-y-3 rounded-md border p-4">
          <div>
            <p className="text-sm font-medium">Email: trusted auto-send rule</p>
            <p className="text-xs text-muted-foreground">
              By default every email draft waits for your approval. Only enable this for low-risk categories you trust. Applies to Gmail inbox runs only; every automatic send is recorded in the audit log.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={rule.enabled} disabled={!canEdit} onChange={(e) => setRule((r) => ({ ...r, enabled: e.target.checked }))} />
            Send drafts automatically for selected categories
          </label>
          {rule.enabled && (
            <div className="flex flex-wrap gap-3">
              {EMAIL_CATEGORIES.map((c) => (
                <label key={c.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    disabled={!canEdit}
                    checked={rule.categories.includes(c.value)}
                    onChange={(e) =>
                      setRule((r) => ({ ...r, categories: e.target.checked ? [...r.categories, c.value] : r.categories.filter((x) => x !== c.value) }))
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
          {rule.enabled && rule.categories.length > 0 && <Alert tone="warning">Emails in these categories will be sent without review.</Alert>}
        </div>

        <div className="flex justify-end">
          <Button onClick={save} loading={saving} disabled={!canEdit}>
            Save agent settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
