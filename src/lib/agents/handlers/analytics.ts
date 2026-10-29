import "server-only";
import type { AnalyticsInput } from "../logic/analytics";
import type { AgentHandler } from "../types";
import { acceptTableUpload, loadStoredTable, readForm, tableSummary, text, type StoredTableRef } from "./shared";

export const analyticsHandler: AgentHandler = {
  async prepare(ctx, req) {
    const form = await readForm(req);
    const upload = (await acceptTableUpload(ctx, form, "file", "datasets", true))!;
    const question = text(form, "question", 1000);
    const input: AnalyticsInput = { dataset: upload.table, question, currency: ctx.currency };
    return {
      input,
      inputSummary: { ...tableSummary(upload.table), question },
      inputRef: { file: upload.ref, question },
    };
  },
  async rebuild(ctx, execution) {
    const ref = execution.input_ref as { file?: StoredTableRef; question?: string | null };
    const table = await loadStoredTable(ctx, ref.file);
    if (!table) throw new Error("Original dataset is no longer available.");
    return { dataset: table, question: ref.question ?? null, currency: ctx.currency } satisfies AnalyticsInput;
  },
};
