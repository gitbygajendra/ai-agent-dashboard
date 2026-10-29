import "server-only";
import { z } from "zod";
import { withUser } from "../../db";
import { AppError } from "../../errors";
import type { LeadInput, LeadResult } from "../logic/leads";
import type { AgentHandler, OrgContext } from "../types";
import type { Table } from "../../files/tabular";
import { acceptTableUpload, loadStoredTable, readForm, tableSummary, text, type StoredTableRef } from "./shared";

const list = z
  .string()
  .max(1000)
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20));

const criteriaSchema = z.object({
  industries: list.default([]),
  locations: list.default([]),
  company_sizes: list.default([]),
  keywords: list.default([]),
  min_score: z.coerce.number().int().min(0).max(100).default(60),
});

async function existingEmails(ctx: OrgContext, table: Table): Promise<string[]> {
  const emails = new Set<string>();
  for (const row of table.rows) {
    for (const v of Object.values(row)) {
      if (typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) emails.add(v.trim().toLowerCase());
    }
  }
  if (!emails.size) return [];
  const rows = await withUser(ctx.user.id, (tx) =>
    tx.query<{ email: string }>("select lower(email) as email from public.contacts where organization_id = $1 and lower(email) = any($2)", [
      ctx.orgId,
      [...emails],
    ]),
  );
  return rows.map((r) => r.email);
}

export const leadsHandler: AgentHandler = {
  async prepare(ctx, req) {
    const form = await readForm(req);
    const source = text(form, "source", 20) === "provider" ? "provider" : "csv";
    if (source === "provider") {
      const provider = await withUser(ctx.user.id, (tx) =>
        tx.one<{ status: string }>("select status from public.integrations where organization_id = $1 and provider = 'lead_provider'", [ctx.orgId]),
      );
      if (provider?.status !== "connected") {
        throw new AppError("PROVIDER_NOT_CONNECTED", "No lead data provider is connected, so live search isn't available. Import a CSV of prospects instead.", 409);
      }
    }
    const upload = (await acceptTableUpload(ctx, form, "file", "prospects", true))!;
    const criteria = criteriaSchema.parse({
      industries: text(form, "industries", 1000) ?? "",
      locations: text(form, "locations", 1000) ?? "",
      company_sizes: text(form, "company_sizes", 1000) ?? "",
      keywords: text(form, "keywords", 1000) ?? "",
      min_score: text(form, "min_score", 3) ?? 60,
    });
    const sender = { name: ctx.fullName ?? undefined, company: ctx.orgName, offering: text(form, "offering", 300) ?? undefined };
    const input: LeadInput = { source: "csv", prospects: upload.table, criteria, existing_emails: await existingEmails(ctx, upload.table), sender };
    return {
      input,
      inputSummary: { ...tableSummary(upload.table), criteria },
      inputRef: { file: upload.ref, criteria, sender },
    };
  },
  async rebuild(ctx, execution) {
    const ref = execution.input_ref as { file: StoredTableRef; criteria: LeadInput["criteria"]; sender: LeadInput["sender"] };
    const table = await loadStoredTable(ctx, ref.file);
    if (!table) throw new Error("Original prospect file is no longer available.");
    return { source: "csv", prospects: table, criteria: ref.criteria, existing_emails: await existingEmails(ctx, table), sender: ref.sender } satisfies LeadInput;
  },
  async onComplete(_tx, _execution, result) {
    const r = result as LeadResult;
    return r.qualified_count > 0 ? { status: "awaiting_approval" } : {};
  },
};
