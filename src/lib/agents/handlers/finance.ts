import "server-only";
import type { FinanceInput } from "../logic/finance";
import type { AgentHandler } from "../types";
import { acceptTableUpload, loadStoredTable, readForm, tableSummary, text, type StoredTableRef } from "./shared";

function options(form: FormData) {
  const window = Number(text(form, "date_window_days", 4) ?? 7);
  return { date_window_days: Number.isFinite(window) ? Math.min(Math.max(window, 0), 60) : 7, amount_tolerance: 0.01 };
}

export const financeHandler: AgentHandler = {
  async prepare(ctx, req) {
    const form = await readForm(req);
    const transactions = (await acceptTableUpload(ctx, form, "transactions", "finance", true))!;
    const invoices = await acceptTableUpload(ctx, form, "invoices", "finance", false);
    const opts = options(form);
    const input: FinanceInput = { transactions: transactions.table, invoices: invoices?.table ?? null, currency: ctx.currency, options: opts };
    return {
      input,
      inputSummary: { transactions: tableSummary(transactions.table), invoices: invoices ? tableSummary(invoices.table) : null },
      inputRef: { transactions: transactions.ref, invoices: invoices?.ref ?? null, options: opts },
    };
  },
  async rebuild(ctx, execution) {
    const ref = execution.input_ref as { transactions: StoredTableRef; invoices: StoredTableRef | null; options: FinanceInput["options"] };
    const transactions = await loadStoredTable(ctx, ref.transactions);
    if (!transactions) throw new Error("Original transactions file is no longer available.");
    return { transactions, invoices: await loadStoredTable(ctx, ref.invoices), currency: ctx.currency, options: ref.options } satisfies FinanceInput;
  },
};
