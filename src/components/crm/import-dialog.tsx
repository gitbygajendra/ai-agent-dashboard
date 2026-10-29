"use client";

import * as React from "react";
import { FileSpreadsheet } from "lucide-react";
import { Alert, Badge, Button, Input, TBody, TD, TH, THead, TR, Table } from "@/components/ui";
import { Dialog } from "@/components/ui/client";
import { api, formatNumber } from "@/lib/utils";
import { FormField, errorMessage } from "./shared";

type ImportResult = { created: number; skipped_duplicates: number; errors: { row: number; message: string }[] };

export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (r: ImportResult) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Import contacts" description="Upload a .csv or .xlsx file (up to 5,000 rows)." className="max-w-xl">
      <ImportForm onClose={onClose} onImported={onImported} />
    </Dialog>
  );
}

function ImportForm({ onClose, onImported }: { onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const inputId = React.useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a CSV or Excel file to import.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await api<ImportResult>("/api/crm/contacts/import", { method: "POST", body });
      setResult(res);
      onImported(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <Alert tone={result.created > 0 ? "success" : "warning"} title={result.created > 0 ? "Import finished" : "Nothing was imported"}>
          {formatNumber(result.created)} created · {formatNumber(result.skipped_duplicates)} skipped as duplicates (same email) · {formatNumber(result.errors.length)}{" "}
          {result.errors.length === 1 ? "row" : "rows"} with errors
        </Alert>
        {result.errors.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Rows that weren&apos;t imported</p>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <THead>
                  <tr>
                    <TH className="w-20">Row</TH>
                    <TH>Problem</TH>
                  </tr>
                </THead>
                <TBody>
                  {result.errors.map((er) => (
                    <TR key={`${er.row}-${er.message}`}>
                      <TD className="tabular-nums">{er.row}</TD>
                      <TD>{er.message}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            {result.errors.length >= 100 && <p className="text-xs text-muted-foreground">Showing the first 100 errors.</p>}
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setResult(null);
              setFile(null);
            }}
          >
            Import another file
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
        <p className="font-medium">Expected columns</p>
        <p className="text-muted-foreground">
          The first row must be a header. A <Badge tone="outline">name</Badge> column is required (or <Badge tone="outline">first_name</Badge> +{" "}
          <Badge tone="outline">last_name</Badge>).
        </p>
        <p className="text-muted-foreground">
          Optional: email, phone, company, source, status (lead, qualified, customer, unqualified, churned), industry, location, company_size. Common
          variations like &ldquo;E-mail&rdquo; or &ldquo;Organization&rdquo; are recognised.
        </p>
        <p className="text-muted-foreground">Contacts whose email already exists are skipped. Imports don&apos;t trigger automations.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <FormField label="File" htmlFor={inputId} hint={file ? `${file.name} · ${formatNumber(file.size / 1024, 1)} KB` : ".csv or .xlsx"}>
        <Input
          id={inputId}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-sm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
        />
      </FormField>
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!file}>
          {!busy && <FileSpreadsheet aria-hidden />}
          Import
        </Button>
      </div>
    </form>
  );
}
