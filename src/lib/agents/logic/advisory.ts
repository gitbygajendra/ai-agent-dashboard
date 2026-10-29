import { type AiRequest, type LogicOutput, type Stage, fail, GROUNDING_RULES, pipelineOutput, readClaudeText, round, runStages } from "./common";

/** Metrics gathered by the server from the organization's own records. */
export type BusinessMetrics = {
  crm: {
    contacts_total: number;
    by_status: Record<string, number>;
    by_source: { source: string; total: number; customers: number }[];
    overdue_tasks: number;
    open_tasks: number;
    demo_records: number;
  };
  deals: {
    open_count: number;
    open_value: number;
    won_count: number;
    won_value: number;
    lost_count: number;
    by_stage: { stage: string; count: number; value: number }[];
    stale_count: number;
    stale_value: number;
    stale_days: number;
  };
  analytics: {
    dataset: string;
    analyzed_at: string;
    revenue_total: number;
    period_change_pct: number | null;
    granularity: string;
    top_item: { name: string; share_pct: number } | null;
    top3_share_pct: number | null;
  } | null;
  finance: {
    analyzed_at: string;
    income_total: number;
    expense_total: number;
    net_profit: number;
    high_findings: number;
    top_expense_category: { category: string; total: number } | null;
  } | null;
  automation: { runs_30d: number; failed_30d: number };
};

export type AdvisoryInput = { question: string; metrics: BusinessMetrics; currency?: string };

export type Evidence = { metric: string; value: string; source: string };

export type Recommendation = {
  key: string;
  title: string;
  rationale: string;
  actions: string[];
  evidence: Evidence[];
  assumptions: string[];
  risks: string[];
  confidence: "low" | "medium" | "high";
  priority: number;
};

export type AdvisoryResult = {
  question: string;
  recommendations: Recommendation[];
  data_coverage: { source: string; available: boolean; note: string }[];
  insufficient_data: boolean;
  missing_data: string[];
  verified_metrics: Evidence[];
  narrative: string;
  narrative_source: "computed" | "ai";
  ai_generated: boolean;
};

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

type Derived = {
  cur: string;
  leads: number;
  qualified: number;
  customers: number;
  pipelineContacts: number;
  conversion: number | null;
  closed: number;
  winRate: number | null;
  earlyValue: number;
};

export type AdvisoryState = {
  input: AdvisoryInput;
  question?: string;
  derived?: Derived;
  recs?: Recommendation[];
  ranked?: {
    top: Recommendation[];
    coverage: AdvisoryResult["data_coverage"];
    missing: string[];
    insufficient: boolean;
    verified: Evidence[];
  };
  output?: LogicOutput<AdvisoryResult>;
};

const money = (cur: string, n: number) => `${cur} ${round(n).toLocaleString("en-US")}`;

/** Stages must only pass JSON-safe data between them (they become separate n8n Code nodes). */
export const ADVISORY_STAGES: Stage<AdvisoryState>[] = [
  {
    name: "collect metrics",
    run(s) {
      const input = s.input;
      const question = String(input?.question ?? "").trim();
      if (!question) return { ...s, output: fail("EMPTY_QUESTION", "Ask a question about your business.") };
      const m = input.metrics;
      if (!m?.crm || !m?.deals || !m?.automation) return { ...s, output: fail("INVALID_INPUT", "Business metrics are missing.") };
      const cur = input.currency || "USD";
      const leads = m.crm.by_status.lead ?? 0;
      const qualified = m.crm.by_status.qualified ?? 0;
      const customers = m.crm.by_status.customer ?? 0;
      const pipelineContacts = leads + qualified + customers + (m.crm.by_status.unqualified ?? 0);
      const conversion = pipelineContacts ? round((customers / pipelineContacts) * 100, 1) : null;
      const closed = m.deals.won_count + m.deals.lost_count;
      const winRate = closed ? round((m.deals.won_count / closed) * 100, 1) : null;
      const earlyValue = m.deals.by_stage.filter((st) => st.stage === "new" || st.stage === "contacted").reduce((a, st) => a + st.value, 0);
      return { ...s, question, derived: { cur, leads, qualified, customers, pipelineContacts, conversion, closed, winRate, earlyValue } };
    },
  },
  {
    name: "detect signals",
    run(s) {
      const m = s.input.metrics;
      const { cur, customers, pipelineContacts, conversion, closed, winRate, earlyValue } = s.derived!;
      const recs: Recommendation[] = [];
      if (m.deals.stale_count > 0) {
        recs.push({
          key: "stale_deals",
          title: `Re-engage ${m.deals.stale_count} stalled deal${m.deals.stale_count > 1 ? "s" : ""}`,
          rationale: `${m.deals.stale_count} open deals worth ${money(cur, m.deals.stale_value)} have not been updated in ${m.deals.stale_days}+ days. Deals that stall usually lose momentum.`,
          actions: ["Sort the pipeline by last update and call or email each stalled deal this week.", "Close out deals that are no longer real so the pipeline reflects reality."],
          evidence: [
            { metric: "Stalled open deals", value: String(m.deals.stale_count), source: "CRM deals" },
            { metric: "Value of stalled deals", value: money(cur, m.deals.stale_value), source: "CRM deals" },
          ],
          assumptions: ["Deal records are updated when progress happens."],
          risks: ["Some deals may be progressing offline without CRM updates."],
          confidence: "high",
          priority: 90 + Math.min(9, m.deals.stale_count),
        });
      }
      if (conversion !== null && pipelineContacts >= 20 && conversion < 10) {
        recs.push({
          key: "lead_conversion",
          title: "Improve lead-to-customer conversion",
          rationale: `Only ${conversion}% of ${pipelineContacts} contacts in the CRM are customers. Faster follow-up and clearer qualification usually lift conversion.`,
          actions: ["Follow up with every new lead within 24 hours (the CRM automation can create the task).", "Define 2-3 qualification questions and mark leads qualified or unqualified after the first call."],
          evidence: [
            { metric: "Contacts (lead/qualified/customer/unqualified)", value: String(pipelineContacts), source: "CRM contacts" },
            { metric: "Customers", value: String(customers), source: "CRM contacts" },
            { metric: "Conversion rate", value: `${conversion}%`, source: "Computed from CRM contacts" },
          ],
          assumptions: ["Contact status is kept up to date."],
          risks: ["A short history can make the rate look worse than it is."],
          confidence: pipelineContacts >= 50 ? "high" : "medium",
          priority: 85,
        });
      }
      if (winRate !== null && closed >= 5 && winRate < 30) {
        recs.push({
          key: "win_rate",
          title: "Find out why deals are being lost",
          rationale: `Win rate is ${winRate}% (${m.deals.won_count} won, ${m.deals.lost_count} lost).`,
          actions: ["Ask lost prospects for a 5-minute feedback call.", "Log a loss reason on each lost deal to spot patterns (price, timing, competitor)."],
          evidence: [
            { metric: "Won deals", value: String(m.deals.won_count), source: "CRM deals" },
            { metric: "Lost deals", value: String(m.deals.lost_count), source: "CRM deals" },
            { metric: "Win rate", value: `${winRate}%`, source: "Computed from CRM deals" },
          ],
          assumptions: ["Lost deals are marked as lost rather than deleted."],
          risks: ["Small samples swing the win rate a lot."],
          confidence: closed >= 15 ? "high" : "medium",
          priority: 80,
        });
      }
        if (m.deals.open_value > 0 && earlyValue / m.deals.open_value > 0.6 && m.deals.open_count >= 5) {
        const share = round((earlyValue / m.deals.open_value) * 100, 1);
        recs.push({
          key: "early_pipeline",
          title: "Move early-stage deals to a qualified conversation",
          rationale: `${share}% of open pipeline value is still in New/Contacted stages.`,
          actions: ["Book discovery calls for the largest early-stage deals.", "Disqualify deals with no response after three attempts."],
          evidence: [
            { metric: "Open pipeline value", value: money(cur, m.deals.open_value), source: "CRM deals" },
            { metric: "Value in New/Contacted", value: money(cur, earlyValue), source: "CRM deals" },
          ],
          assumptions: ["Stages reflect the real buying stage."],
          risks: [],
          confidence: "medium",
          priority: 70,
        });
      }
      if (m.crm.overdue_tasks > 0) {
        recs.push({
          key: "overdue_tasks",
          title: `Clear ${m.crm.overdue_tasks} overdue follow-up${m.crm.overdue_tasks > 1 ? "s" : ""}`,
          rationale: "Overdue follow-ups are the cheapest conversion wins: these people already showed interest.",
          actions: ["Block 30 minutes today to complete or reschedule overdue tasks."],
          evidence: [{ metric: "Overdue tasks", value: String(m.crm.overdue_tasks), source: "CRM activities" }],
          assumptions: [],
          risks: [],
          confidence: "high",
          priority: 75,
        });
      }
      const sources = m.crm.by_source.filter((s) => s.total >= 5);
      if (sources.length >= 2) {
        const ranked = sources.map((s) => ({ ...s, rate: round((s.customers / s.total) * 100, 1) })).sort((a, b) => b.rate - a.rate);
        const best = ranked[0];
        const worst = ranked[ranked.length - 1];
        if (best.rate > worst.rate) {
          recs.push({
            key: "lead_sources",
            title: `Put more effort into "${best.source}" leads`,
            rationale: `"${best.source}" converts at ${best.rate}% versus ${worst.rate}% for "${worst.source}".`,
            actions: [`Shift time or budget toward ${best.source}.`, `Review why ${worst.source} leads convert less (fit, follow-up speed, messaging).`],
            evidence: ranked.slice(0, 4).map((s) => ({ metric: `Conversion from ${s.source}`, value: `${s.rate}% (${s.customers}/${s.total})`, source: "CRM contacts" })),
            assumptions: ["Lead source is recorded consistently."],
            risks: ["Source volume may be too small to be conclusive."],
            confidence: best.total >= 20 ? "medium" : "low",
            priority: 65,
          });
        }
      }
      if (m.analytics && m.analytics.period_change_pct !== null && m.analytics.period_change_pct <= -10) {
        recs.push({
          key: "revenue_decline",
          title: "Investigate the latest revenue decline",
          rationale: `In "${m.analytics.dataset}", the latest ${m.analytics.granularity} is down ${Math.abs(m.analytics.period_change_pct)}% versus the previous one.`,
          actions: ["Check whether the latest period is complete.", "Compare the top products period over period to find which ones dropped."],
          evidence: [
            { metric: "Period-over-period change", value: `${m.analytics.period_change_pct}%`, source: `Data Analytics run (${m.analytics.analyzed_at.slice(0, 10)})` },
            { metric: "Revenue in dataset", value: money(cur, m.analytics.revenue_total), source: `Data Analytics run (${m.analytics.analyzed_at.slice(0, 10)})` },
          ],
          assumptions: ["The uploaded dataset covers all sales channels."],
          risks: ["A partial final period looks like a decline."],
          confidence: "medium",
          priority: 88,
        });
      }
      if (m.analytics?.top3_share_pct && m.analytics.top3_share_pct >= 60) {
        recs.push({
          key: "concentration",
          title: "Reduce dependence on your top products",
          rationale: `The top 3 products make up ${m.analytics.top3_share_pct}% of revenue in "${m.analytics.dataset}".`,
          actions: ["Protect supply and pricing for the top products.", "Test bundles that pair top products with slower ones."],
          evidence: [{ metric: "Top 3 product share", value: `${m.analytics.top3_share_pct}%`, source: "Data Analytics run" }],
          assumptions: [],
          risks: ["Concentration can be a deliberate strategy."],
          confidence: "medium",
          priority: 55,
        });
      }
      if (m.finance && m.finance.expense_total > m.finance.income_total) {
        recs.push({
          key: "costs",
          title: "Bring expenses back under income",
          rationale: `The last finance review shows expenses of ${money(cur, m.finance.expense_total)} against income of ${money(cur, m.finance.income_total)}.`,
          actions: [m.finance.top_expense_category ? `Start with "${m.finance.top_expense_category.category}" (${money(cur, m.finance.top_expense_category.total)}).` : "Review the largest expense categories first.", "Cancel unused subscriptions and renegotiate recurring costs."],
          evidence: [
            { metric: "Income", value: money(cur, m.finance.income_total), source: `Finance review (${m.finance.analyzed_at.slice(0, 10)})` },
            { metric: "Expenses", value: money(cur, m.finance.expense_total), source: `Finance review (${m.finance.analyzed_at.slice(0, 10)})` },
          ],
          assumptions: ["The reviewed file covers a full period."],
          risks: ["One-off investments can make a single period look negative."],
          confidence: "medium",
          priority: 86,
        });
      }
      if (m.automation.runs_30d >= 5 && m.automation.failed_30d / m.automation.runs_30d > 0.2) {
        const rate = round((m.automation.failed_30d / m.automation.runs_30d) * 100, 1);
        recs.push({
          key: "automation_failures",
          title: "Fix failing automations",
          rationale: `${rate}% of agent runs failed in the last 30 days.`,
          actions: ["Open Workflow Runs, filter by Failed, and fix the most common error."],
          evidence: [{ metric: "Failed runs (30 days)", value: `${m.automation.failed_30d} of ${m.automation.runs_30d}`, source: "Workflow runs" }],
          assumptions: [],
          risks: [],
          confidence: "high",
          priority: 60,
        });
      }
      return { ...s, recs };
    },
  },
  {
    name: "rank and select recommendations",
    run(s) {
      const m = s.input.metrics;
      const question = s.question!;
      const { cur, conversion, closed, winRate } = s.derived!;
      const recs = [...s.recs!];
      const wanted = /\b(\d|one|two|three|four|five)\b\s+(actions|recommendations|ideas|steps|things|ways)/i.exec(question);
      const limit = wanted ? Math.min(5, Number(wanted[1]) || WORD_NUMBERS[wanted[1].toLowerCase()] || 5) : 5;
      recs.sort((a, b) => b.priority - a.priority);

      const coverage = [
        { source: "CRM contacts", available: m.crm.contacts_total > 0, note: `${m.crm.contacts_total} contacts${m.crm.demo_records ? ` (${m.crm.demo_records} demo)` : ""}` },
        { source: "CRM deals", available: m.deals.open_count + closed > 0, note: `${m.deals.open_count} open, ${closed} closed` },
        { source: "Sales data (Data Analytics)", available: Boolean(m.analytics), note: m.analytics ? `"${m.analytics.dataset}"` : "No dataset analyzed yet" },
        { source: "Finance review", available: Boolean(m.finance), note: m.finance ? `Reviewed ${m.finance.analyzed_at.slice(0, 10)}` : "No finance review yet" },
      ];
      const missing = coverage.filter((c) => !c.available).map((c) => c.source);
      const insufficient = recs.length === 0 && coverage.filter((c) => c.available).length < 2;

      const verified: Evidence[] = [
        { metric: "Contacts", value: String(m.crm.contacts_total), source: "CRM" },
        { metric: "Open pipeline", value: `${m.deals.open_count} deals, ${money(cur, m.deals.open_value)}`, source: "CRM" },
        ...(winRate !== null ? [{ metric: "Win rate", value: `${winRate}%`, source: "CRM" }] : []),
        ...(conversion !== null ? [{ metric: "Lead-to-customer conversion", value: `${conversion}%`, source: "CRM" }] : []),
        ...(m.analytics ? [{ metric: "Revenue in last analyzed dataset", value: money(cur, m.analytics.revenue_total), source: "Data Analytics" }] : []),
        ...(m.finance ? [{ metric: "Net profit in last finance review", value: money(cur, m.finance.net_profit), source: "Finance review" }] : []),
      ];
      return { ...s, ranked: { top: recs.slice(0, limit), coverage, missing, insufficient, verified } };
    },
  },
  {
    name: "write narrative",
    run(s) {
      const question = s.question!;
      const { top, coverage, missing, insufficient, verified } = s.ranked!;
      const narrative = insufficient
        ? `There isn't enough data yet to make evidence-based recommendations. Add data from: ${missing.join(", ")}.`
        : top.length
          ? `Based on your records, the highest-impact actions are: ${top.map((r, i) => `${i + 1}) ${r.title}`).join("; ")}. Each recommendation lists the figures it is based on.`
          : "Your current records don't show a clear problem area. Add more data (sales datasets, finance reviews) for sharper recommendations.";

      const result: AdvisoryResult = {
        question,
        recommendations: top,
        data_coverage: coverage,
        insufficient_data: insufficient,
        missing_data: missing,
        verified_metrics: verified,
        narrative,
        narrative_source: "computed",
        ai_generated: false,
      };
      const ai: AiRequest | null = insufficient
        ? null
        : {
            system: [
              "You are a pragmatic business advisor for a small business.",
              GROUNDING_RULES,
              "The recommendations below were derived from the owner's records. Explain them in answer to the question; do not add recommendations that the metrics do not support.",
              "Label anything that is not a provided figure as an assumption. Keep it under 250 words, plain text.",
            ].join("\n"),
            prompt: `Question: ${question}\n\nVerified metrics: ${JSON.stringify(verified)}\nData coverage: ${JSON.stringify(coverage)}\nRecommendations: ${JSON.stringify(top.map((r) => ({ ...r, priority: undefined })))}`,
            max_tokens: 1200,
          };
      return { ...s, output: { ok: true, result, ai_request: ai } };
    },
  },
];

export function advise(input: AdvisoryInput): LogicOutput<AdvisoryResult> {
  return pipelineOutput(runStages(ADVISORY_STAGES, { input }));
}

export function mergeAdvisoryAi(result: AdvisoryResult, aiResponse: unknown): AdvisoryResult {
  const text = readClaudeText(aiResponse);
  if (!text) return result;
  return { ...result, narrative: text.slice(0, 4000), narrative_source: "ai", ai_generated: true };
}
