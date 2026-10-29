"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Database, Download, Eye, Upload, UserPlus } from "lucide-react";
import { Badge, Button, PageHeader, buttonVariants } from "@/components/ui";
import { Tabs, toast } from "@/components/ui/client";
import { api, cn } from "@/lib/utils";
import { ContactFormDialog } from "./contact-form-dialog";
import { ContactsTab } from "./contacts-tab";
import { ImportDialog } from "./import-dialog";
import { PipelineTab } from "./pipeline-tab";
import { ConfirmDialog, errorMessage } from "./shared";
import { TasksTab } from "./tasks-tab";

const TABS = [
  { value: "contacts", label: "Contacts" },
  { value: "pipeline", label: "Pipeline" },
  { value: "tasks", label: "Tasks" },
] as const;
type Tab = (typeof TABS)[number]["value"];

function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.value === v);
}

export function CrmWorkspace({ canWrite, currency }: { canWrite: boolean; currency: string }) {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "contacts";

  const [refreshKey, setRefreshKey] = React.useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);
  const [dialog, setDialog] = React.useState<"contact" | "import" | "removeDemo" | null>(null);
  const [demoLoading, setDemoLoading] = React.useState(false);

  function setTab(next: Tab) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "contacts") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  async function loadDemo() {
    setDemoLoading(true);
    try {
      const res = await api<{ created: number }>("/api/crm/demo", { method: "POST" });
      toast(res.created > 0 ? `Added ${res.created} demo contacts with deals and tasks (labeled “Demo”).` : "Demo data is already loaded.", "success");
      refresh();
    } catch (err) {
      toast(`Couldn't load demo data: ${errorMessage(err)}`, "danger");
    } finally {
      setDemoLoading(false);
    }
  }

  async function removeDemo() {
    const res = await api<{ removed: number }>("/api/crm/demo", { method: "DELETE" });
    toast(res.removed > 0 ? `Removed ${res.removed} demo contacts and their deals.` : "There was no demo data to remove.", "success");
    refresh();
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM"
        description="Contacts, pipeline and follow-ups. Automations run when leads and deals change."
        actions={
          <>
            {canWrite ? (
              <>
                <Button onClick={() => setDialog("contact")}>
                  <UserPlus aria-hidden />
                  Add contact
                </Button>
                <Button variant="outline" onClick={() => setDialog("import")}>
                  <Upload aria-hidden />
                  Import CSV
                </Button>
              </>
            ) : (
              <Badge tone="neutral" title="Viewers can browse but not change CRM records">
                <Eye className="size-3" aria-hidden />
                View only
              </Badge>
            )}
            <a href="/api/crm/contacts/export" download className={cn(buttonVariants({ variant: "outline" }))}>
              <Download aria-hidden />
              Export CSV
            </a>
            {canWrite && (
              <div className="flex h-9 items-center gap-0.5 rounded-md border bg-card pl-2 text-xs" role="group" aria-label="Demo data">
                <Database className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="mr-1 text-muted-foreground">Demo</span>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={loadDemo} loading={demoLoading} aria-label="Load demo data">
                  Load
                </Button>
                <Button variant="ghost" size="sm" className="mr-1 h-7 px-2 text-muted-foreground" onClick={() => setDialog("removeDemo")} aria-label="Remove demo data">
                  Remove
                </Button>
              </div>
            )}
          </>
        }
      />

      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} />

      <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label}>
        {tab === "contacts" && (
          <ContactsTab
            canWrite={canWrite}
            refreshKey={refreshKey}
            onAddContact={() => setDialog("contact")}
            onImport={() => setDialog("import")}
            onLoadDemo={loadDemo}
            demoBusy={demoLoading}
          />
        )}
        {tab === "pipeline" && <PipelineTab canWrite={canWrite} currency={currency} refreshKey={refreshKey} />}
        {tab === "tasks" && <TasksTab canWrite={canWrite} refreshKey={refreshKey} />}
      </div>

      {canWrite && (
        <>
          <ContactFormDialog
            open={dialog === "contact"}
            onClose={() => setDialog(null)}
            onSaved={(c) => {
              setDialog(null);
              toast(`Added ${c.name}. Automations may add a follow-up task shortly.`, "success");
              refresh();
            }}
          />
          <ImportDialog
            open={dialog === "import"}
            onClose={() => setDialog(null)}
            onImported={(r) => {
              if (r.created > 0) refresh();
            }}
          />
          <ConfirmDialog open={dialog === "removeDemo"} onClose={() => setDialog(null)} title="Remove demo data?" confirmLabel="Remove demo data" onConfirm={removeDemo}>
            This deletes every record labeled &ldquo;Demo&rdquo; — demo contacts, their deals and their activities. Your own records aren&apos;t affected.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}
