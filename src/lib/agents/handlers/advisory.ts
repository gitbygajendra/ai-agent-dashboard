import "server-only";
import { z } from "zod";
import { getBusinessMetrics } from "../../metrics";
import type { AdvisoryInput, AdvisoryResult } from "../logic/advisory";
import type { AgentHandler } from "../types";
import { readJson } from "./shared";

const bodySchema = z.object({ question: z.string().trim().min(3, "Ask a question.").max(1000) });

export const advisoryHandler: AgentHandler = {
  async prepare(ctx, req) {
    const { question } = bodySchema.parse(await readJson(req));
    const metrics = await getBusinessMetrics(ctx);
    const input: AdvisoryInput = { question, metrics, currency: ctx.currency };
    return {
      input,
      inputSummary: { question, contacts: metrics.crm.contacts_total, has_analytics: Boolean(metrics.analytics), has_finance: Boolean(metrics.finance) },
      inputRef: { question },
    };
  },
  async rebuild(ctx, execution) {
    const question = String((execution.input_ref as { question?: string }).question ?? "");
    return { question, metrics: await getBusinessMetrics(ctx), currency: ctx.currency } satisfies AdvisoryInput;
  },
  async onComplete(tx, execution, result) {
    const r = result as AdvisoryResult;
    if (!Array.isArray(r.recommendations)) return {};
    for (const rec of r.recommendations.slice(0, 10)) {
      await tx.query(
        `insert into public.recommendations (organization_id, execution_id, key, title, rationale, actions, evidence, assumptions, risks, confidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          execution.organization_id,
          execution.id,
          String(rec.key ?? "").slice(0, 60) || null,
          String(rec.title).slice(0, 300),
          String(rec.rationale ?? "").slice(0, 4000),
          JSON.stringify((rec.actions ?? []).slice(0, 10)),
          JSON.stringify((rec.evidence ?? []).slice(0, 20)),
          JSON.stringify(rec.assumptions ?? []),
          JSON.stringify((rec.risks ?? []).slice(0, 10)),
          ["low", "medium", "high"].includes(rec.confidence) ? rec.confidence : null,
        ],
      );
    }
    return {};
  },
};
