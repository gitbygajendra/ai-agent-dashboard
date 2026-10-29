import {
  type AiRequest,
  type LogicOutput,
  type Row,
  type Stage,
  detectDayFirst,
  extractJson,
  fail,
  findColumn,
  GROUNDING_RULES,
  mean,
  parseDate,
  parseNumber,
  pctChange,
  pipelineOutput,
  readClaudeText,
  round,
  runStages,
  stdDev,
  sum,
  truncate,
} from "./common";

export type AnalyticsInput = {
  dataset: { name: string; columns: string[]; rows: Row[] };
  question?: string | null;
  currency?: string;
};

export type Kpi = {
  key: string;
  label: string;
  value: number | string | null;
  format: "currency" | "number" | "percent" | "text";
  change_pct?: number | null;
  note?: string;
};

export type AnalyticsResult = {
  dataset: {
    name: string;
    row_count: number;
    column_count: number;
    date_range: { start: string; end: string } | null;
    detected: Record<string, string | null>;
    value_label: string;
  };
  kpis: Kpi[];
  metrics: {
    revenue_total: number;
    order_count: number;
    avg_order_value: number;
    unique_customers: number | null;
    unique_products: number | null;
    period_change_pct: number | null;
  };
  charts: {
    granularity: "day" | "week" | "month";
    value_over_time: { period: string; value: number }[];
    top_items: { name: string; value: number; quantity: number | null; share_pct: number }[];
    by_category: { name: string; value: number }[];
  };
  anomalies: { type: string; description: string; rows?: number[] }[];
  opportunities: string[];
  data_quality: {
    missing_values: { column: string; count: number }[];
    unparseable_values: number;
    rows_without_date: number;
  };
  answer: { question: string; text: string; source: "computed" | "ai" } | null;
  insights: string[];
  summary: string;
  summary_source: "computed" | "ai";
  ai_generated: boolean;
  currency: string;
};

const DATE_PATTERNS = [/^(order_)?date$/, /date/, /^day$/, /month/, /time/, /period/];
const REVENUE_PATTERNS = [/^revenue$/, /revenue/, /^sales$/, /sales_amount/, /^total$/, /total_amount/, /amount/, /^sales/, /gross/, /net/, /value/];
const PRODUCT_PATTERNS = [/^product$/, /product/, /^item$/, /item/, /sku/, /service/, /^name$/];
const CUSTOMER_PATTERNS = [/^customer$/, /customer/, /client/, /buyer/, /account/, /email/];
const QTY_PATTERNS = [/^qty$/, /quantity/, /units/, /^count$/];
const PRICE_PATTERNS = [/unit_price/, /^price$/, /price/, /rate/];
const CATEGORY_PATTERNS = [/category/, /segment/, /region/, /channel/, /type/];

function isNumericColumn(rows: Row[], col: string): boolean {
  let numeric = 0;
  let filled = 0;
  for (const r of rows.slice(0, 500)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    filled++;
    if (parseNumber(v) !== null) numeric++;
  }
  return filled > 0 && numeric / filled >= 0.9;
}

function isDateColumn(rows: Row[], col: string): boolean {
  let ok = 0;
  let filled = 0;
  for (const r of rows.slice(0, 200)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    filled++;
    if (typeof v === "number") continue; // plain numbers are not dates unless the header says so
    if (parseDate(v) !== null) ok++;
  }
  return filled > 0 && ok / filled >= 0.9;
}

function periodKey(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1); // Monday
  return d.toISOString().slice(0, 10);
}

type Granularity = "day" | "week" | "month";

/** Pipeline state. Crosses n8n node boundaries as JSON, so only plain data. */
export type AnalyticsState = {
  input: AnalyticsInput;
  columns?: string[];
  currency?: string;
  cols?: {
    date: string | null;
    revenue: string | null;
    quantity: string | null;
    price: string | null;
    product: string | null;
    customer: string | null;
    category: string | null;
    value: string | null;
    derivedRevenue: boolean;
    valueLabel: string;
    isRevenue: boolean;
    dayFirst: boolean;
  };
  agg?: {
    values: number[];
    dated: { date: string; value: number; row: number }[];
    byItem: { name: string; value: number; quantity: number }[];
    byCategory: { name: string; value: number }[];
    customerCount: number;
    negativeRows: number[];
    productByDate: { month: string; name: string; value: number }[];
    unparseable: number;
    rowsWithoutDate: number;
    total: number;
    orderCount: number;
  };
  trend?: { granularity: Granularity; series: { period: string; value: number }[]; dateRange: { start: string; end: string } | null; periodChange: number | null };
  topItems?: AnalyticsResult["charts"]["top_items"];
  categories?: AnalyticsResult["charts"]["by_category"];
  anomalies?: AnalyticsResult["anomalies"];
  kpis?: Kpi[];
  opportunities?: string[];
  missing?: AnalyticsResult["data_quality"]["missing_values"];
  output?: LogicOutput<AnalyticsResult>;
};

const detectColumns: Stage<AnalyticsState> = {
  name: "detect columns",
  run(s) {
    const input = s.input;
    const ds = input?.dataset;
    if (!ds || !Array.isArray(ds.rows) || !Array.isArray(ds.columns)) {
      return { ...s, output: fail("INVALID_INPUT", "Dataset is missing or malformed.") };
    }
    if (ds.rows.length === 0) return { ...s, output: fail("EMPTY_DATASET", "The file has no data rows.") };
    const columns = ds.columns.filter((c) => typeof c === "string" && c.trim());
    if (columns.length === 0) return { ...s, output: fail("NO_HEADERS", "The file needs a header row with column names.") };
    const rows = ds.rows;
    const currency = input.currency || "USD";

    const numericCols = columns.filter((c) => isNumericColumn(rows, c));
    const dateCol =
      findColumn(columns.filter((c) => isDateColumn(rows, c)), DATE_PATTERNS) ??
      columns.find((c) => isDateColumn(rows, c)) ??
      null;
    const textCols = columns.filter((c) => !numericCols.includes(c) && c !== dateCol);

    let revenueCol = findColumn(numericCols, REVENUE_PATTERNS);
    const qtyCol = findColumn(numericCols, QTY_PATTERNS, revenueCol ? [revenueCol] : []);
    const priceCol = findColumn(numericCols, PRICE_PATTERNS, [revenueCol ?? "", qtyCol ?? ""]);
    // Prefer a price column over a generic "amount" only when there is no revenue-ish column.
    if (revenueCol && priceCol === revenueCol) revenueCol = null;
    const derivedRevenue = Boolean(!revenueCol && qtyCol && priceCol);
    const valueCol = revenueCol ?? (derivedRevenue ? null : numericCols.find((c) => c !== qtyCol) ?? null);

    if (!revenueCol && !derivedRevenue && !valueCol) {
      return { ...s, output: fail("NO_NUMERIC_COLUMN", "The dataset needs at least one numeric column (for example revenue, amount or quantity).") };
    }
    const valueLabel = revenueCol ? "Revenue" : derivedRevenue ? "Revenue (quantity × price)" : String(valueCol);
    const isRevenue = Boolean(revenueCol || derivedRevenue);

    const productCol = findColumn(textCols, PRODUCT_PATTERNS);
    const customerCol = findColumn(textCols, CUSTOMER_PATTERNS, productCol ? [productCol] : []);
    const categoryCol = findColumn(textCols, CATEGORY_PATTERNS, [productCol ?? "", customerCol ?? ""]);
    const dayFirst = dateCol ? detectDayFirst(rows.slice(0, 500).map((r) => r[dateCol])) : false;

    return {
      ...s,
      columns,
      currency,
      cols: { date: dateCol, revenue: revenueCol, quantity: qtyCol, price: priceCol, product: productCol, customer: customerCol, category: categoryCol, value: revenueCol ?? valueCol, derivedRevenue, valueLabel, isRevenue, dayFirst },
    };
  },
};

const aggregateRows: Stage<AnalyticsState> = {
  name: "aggregate rows",
  run(s) {
    const rows = s.input.dataset.rows;
    const c = s.cols!;
    let unparseable = 0;
    let rowsWithoutDate = 0;
    const values: number[] = [];
    const dated: { date: string; value: number; row: number }[] = [];
    const byItem = new Map<string, { value: number; quantity: number }>();
    const byCategory = new Map<string, number>();
    const customers = new Set<string>();
    const negativeRows: number[] = [];
    const productByDate: { month: string; name: string; value: number }[] = [];

    rows.forEach((r, i) => {
      let v: number | null;
      if (c.derivedRevenue) {
        const q = parseNumber(r[c.quantity!]);
        const p = parseNumber(r[c.price!]);
        v = q !== null && p !== null ? q * p : null;
      } else {
        v = parseNumber(r[c.value!]);
      }
      if (v === null) {
        unparseable++;
        return;
      }
      values.push(v);
      if (v < 0) negativeRows.push(i + 2); // +2: header row and 1-based numbering
      if (c.date) {
        const d = parseDate(r[c.date], c.dayFirst);
        if (d) {
          dated.push({ date: d, value: v, row: i + 2 });
          if (c.product) {
            productByDate.push({ month: d.slice(0, 7), name: String(r[c.product] ?? "").trim() || "(blank)", value: v });
          }
        } else rowsWithoutDate++;
      }
      if (c.product) {
        const name = String(r[c.product] ?? "").trim() || "(blank)";
        const entry = byItem.get(name) ?? { value: 0, quantity: 0 };
        entry.value += v;
        entry.quantity += c.quantity ? parseNumber(r[c.quantity]) ?? 0 : 0;
        byItem.set(name, entry);
      }
      if (c.category) {
        const name = String(r[c.category] ?? "").trim() || "(blank)";
        byCategory.set(name, (byCategory.get(name) ?? 0) + v);
      }
      if (c.customer) {
        const cust = String(r[c.customer] ?? "").trim().toLowerCase();
        if (cust) customers.add(cust);
      }
    });

    if (values.length === 0) {
      return { ...s, output: fail("NO_VALID_VALUES", `No rows had a readable number in "${c.revenue ?? c.value ?? c.price}".`) };
    }
    return {
      ...s,
      agg: {
        values,
        dated,
        byItem: [...byItem.entries()].map(([name, e]) => ({ name, value: e.value, quantity: e.quantity })),
        byCategory: [...byCategory.entries()].map(([name, value]) => ({ name, value })),
        customerCount: customers.size,
        negativeRows,
        productByDate,
        unparseable,
        rowsWithoutDate,
        total: sum(values),
        orderCount: values.length,
      },
    };
  },
};

const trendByPeriod: Stage<AnalyticsState> = {
  name: "trend by period",
  run(s) {
    const dated = [...s.agg!.dated];
    let granularity: Granularity = "month";
    let series: { period: string; value: number }[] = [];
    let dateRange: { start: string; end: string } | null = null;
    let periodChange: number | null = null;
    if (dated.length) {
      dated.sort((a, b) => a.date.localeCompare(b.date));
      dateRange = { start: dated[0].date, end: dated[dated.length - 1].date };
      const spanDays = (Date.parse(dateRange.end) - Date.parse(dateRange.start)) / 86400000;
      granularity = spanDays <= 45 ? "day" : spanDays <= 180 ? "week" : "month";
      const buckets = new Map<string, number>();
      for (const d of dated) {
        const k = periodKey(d.date, granularity);
        buckets.set(k, (buckets.get(k) ?? 0) + d.value);
      }
      series = [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, value]) => ({ period, value: round(value) }));
      if (series.length >= 2) {
        periodChange = pctChange(series[series.length - 1].value, series[series.length - 2].value);
      }
    }
    return { ...s, agg: { ...s.agg!, dated }, trend: { granularity, series, dateRange, periodChange } };
  },
};

const topItems: Stage<AnalyticsState> = {
  name: "top items and categories",
  run(s) {
    const { byItem, byCategory, total } = s.agg!;
    const items = [...byItem]
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
      .map((e) => ({
        name: truncate(e.name, 60),
        value: round(e.value),
        quantity: s.cols!.quantity ? round(e.quantity) : null,
        share_pct: total ? round((e.value / total) * 100, 1) : 0,
      }));
    const categories = [...byCategory]
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
      .map((e) => ({ name: truncate(e.name, 60), value: round(e.value) }));
    return { ...s, topItems: items, categories };
  },
};

const findAnomalies: Stage<AnalyticsState> = {
  name: "find anomalies",
  run(s) {
    const { values, dated, negativeRows, orderCount } = s.agg!;
    const { series, granularity } = s.trend!;
    const valueLabel = s.cols!.valueLabel;
    const anomalies: AnalyticsResult["anomalies"] = [];
    if (negativeRows.length) {
      anomalies.push({
        type: "negative_values",
        description: `${negativeRows.length} row(s) have negative ${valueLabel.toLowerCase()} (refunds or data entry errors?).`,
        rows: negativeRows.slice(0, 50),
      });
    }
    if (series.length >= 6) {
      const vals = series.map((p) => p.value);
      const m = mean(vals);
      const sd = stdDev(vals);
      if (sd > 0) {
        for (const p of series) {
          const z = (p.value - m) / sd;
          if (Math.abs(z) >= 2.5) {
            anomalies.push({
              type: z > 0 ? "spike" : "drop",
              description: `${granularity === "month" ? "Month" : granularity === "week" ? "Week of" : "Day"} ${p.period}: ${valueLabel.toLowerCase()} ${round(p.value)} is ${Math.abs(round(z, 1))} standard deviations ${z > 0 ? "above" : "below"} the average (${round(m)}).`,
            });
          }
        }
      }
    }
    if (orderCount >= 20) {
      const m = mean(values);
      const sd = stdDev(values);
      if (sd > 0) {
        const outliers = dated.length ? dated.filter((d) => (d.value - m) / sd >= 4).map((d) => d.row) : [];
        if (outliers.length) {
          anomalies.push({
            type: "large_transactions",
            description: `${outliers.length} unusually large row(s) (4+ standard deviations above the mean of ${round(m)}).`,
            rows: outliers.slice(0, 50),
          });
        }
      }
    }
    return { ...s, anomalies };
  },
};

const computeKpis: Stage<AnalyticsState> = {
  name: "compute KPIs",
  run(s) {
    const { total, orderCount, byItem, customerCount } = s.agg!;
    const { periodChange, granularity } = s.trend!;
    const c = s.cols!;
    const items = s.topItems!;
    const { valueLabel, isRevenue } = c;

    // Opportunities (only statements directly supported by the numbers)
    const opportunities: string[] = [];
    if (items.length >= 3) {
      const top3Share = round(items.slice(0, 3).reduce((a, t) => a + t.share_pct, 0), 1);
      if (top3Share >= 60) {
        opportunities.push(`The top 3 items produce ${top3Share}% of ${valueLabel.toLowerCase()}: revenue is concentrated, so stock-outs or price changes on these items carry high risk.`);
      }
      const tail = byItem.filter((e) => total && e.value / total < 0.01).length;
      if (tail >= 5) {
        opportunities.push(`${tail} items each contribute under 1% of ${valueLabel.toLowerCase()}; review whether to promote, bundle or retire them.`);
      }
    }
    if (periodChange !== null && periodChange <= -10) {
      opportunities.push(`The latest ${granularity} is down ${Math.abs(periodChange)}% versus the previous one; check whether this period is complete before acting.`);
    } else if (periodChange !== null && periodChange >= 10) {
      opportunities.push(`The latest ${granularity} is up ${periodChange}% versus the previous one; identify which items drove the growth.`);
    }

    const rows = s.input.dataset.rows;
    const missing = s.columns!
      .map((col) => ({ column: col, count: rows.filter((r) => r[col] === null || r[col] === undefined || r[col] === "").length }))
      .filter((m) => m.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const kpis: Kpi[] = [
      { key: "total", label: isRevenue ? "Total revenue" : `Total ${valueLabel}`, value: round(total), format: isRevenue ? "currency" : "number", change_pct: periodChange, note: periodChange !== null ? `latest ${granularity} vs previous` : undefined },
      { key: "rows", label: "Rows analyzed", value: orderCount, format: "number" },
      { key: "average", label: isRevenue ? "Average order value" : `Average ${valueLabel}`, value: round(total / orderCount), format: isRevenue ? "currency" : "number" },
    ];
    if (c.customer) kpis.push({ key: "customers", label: "Unique customers", value: customerCount, format: "number" });
    if (c.product) kpis.push({ key: "products", label: "Unique products", value: byItem.length, format: "number" });
    if (items[0]) kpis.push({ key: "top_item", label: "Top product", value: items[0].name, format: "text", note: `${items[0].share_pct}% of total` });
    return { ...s, kpis, opportunities, missing };
  },
};

const answerAndSummarize: Stage<AnalyticsState> = {
  name: "answer question",
  run(s) {
    const { input, columns, currency, cols: c, agg, trend, topItems: items, categories, anomalies, kpis, opportunities, missing } = s as Required<AnalyticsState>;
    const { total, orderCount, dated, productByDate, byItem, customerCount, unparseable, rowsWithoutDate } = agg;
    const { series, granularity, dateRange, periodChange } = trend;
    const { valueLabel, isRevenue } = c;

    const question = (input.question ?? "").trim();
    const answer = question ? answerQuestion(question, { dated, productByDate, productCol: c.product, total, topItems: items, series, granularity, valueLabel, currency }) : null;

    const insights: string[] = [];
    insights.push(`${valueLabel} across ${orderCount} rows totals ${fmt(total, currency, isRevenue)}${dateRange ? ` between ${dateRange.start} and ${dateRange.end}` : ""}.`);
    if (items[0]) insights.push(`"${items[0].name}" is the top product at ${fmt(items[0].value, currency, isRevenue)} (${items[0].share_pct}% of total).`);
    if (periodChange !== null) insights.push(`The latest ${granularity} (${series[series.length - 1].period}) changed ${periodChange > 0 ? "+" : ""}${periodChange}% versus the previous ${granularity}.`);
    if (categories[0]) insights.push(`Largest ${c.category}: "${categories[0].name}" with ${fmt(categories[0].value, currency, isRevenue)}.`);

    const result: AnalyticsResult = {
      dataset: {
        name: input.dataset.name,
        row_count: input.dataset.rows.length,
        column_count: columns.length,
        date_range: dateRange,
        detected: { date: c.date, revenue: c.revenue, quantity: c.quantity, price: c.price, product: c.product, customer: c.customer, category: c.category, value: c.value },
        value_label: valueLabel,
      },
      kpis,
      metrics: {
        revenue_total: isRevenue ? round(total) : 0,
        order_count: orderCount,
        avg_order_value: round(total / orderCount),
        unique_customers: c.customer ? customerCount : null,
        unique_products: c.product ? byItem.length : null,
        period_change_pct: periodChange,
      },
      charts: { granularity, value_over_time: series, top_items: items, by_category: categories },
      anomalies,
      opportunities,
      data_quality: { missing_values: missing, unparseable_values: unparseable, rows_without_date: rowsWithoutDate },
      answer,
      insights,
      summary: insights.join(" "),
      summary_source: "computed",
      ai_generated: false,
      currency,
    };
    return { ...s, output: { ok: true, result, ai_request: buildAiRequest(result, question) } };
  },
};

/** The Data Analytics pipeline; each stage is a node in the n8n workflow. */
export const ANALYTICS_STAGES: Stage<AnalyticsState>[] = [detectColumns, aggregateRows, trendByPeriod, topItems, findAnomalies, computeKpis, answerAndSummarize];

export function analyzeDataset(input: AnalyticsInput): LogicOutput<AnalyticsResult> {
  return pipelineOutput(runStages(ANALYTICS_STAGES, { input }));
}

function fmt(n: number, currency: string, isCurrency: boolean) {
  const v = round(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return isCurrency ? `${currency} ${v}` : v;
}

function answerQuestion(
  question: string,
  ctx: {
    dated: { date: string; value: number; row: number }[];
    productByDate: { month: string; name: string; value: number }[];
    productCol: string | null;
    total: number;
    topItems: AnalyticsResult["charts"]["top_items"];
    series: { period: string; value: number }[];
    granularity: string;
    valueLabel: string;
    currency: string;
  },
): AnalyticsResult["answer"] {
  const q = question.toLowerCase();
  const wantsTop = /(top|highest|best|most|biggest|leading)/.test(q) && /(product|item|sku|service)/.test(q);
  if (wantsTop && ctx.productCol) {
    let scope = "the whole dataset";
    let items = ctx.topItems;
    const monthMatch = /(this|current|latest|last|previous) month/.exec(q);
    if (monthMatch && ctx.productByDate.length) {
      const months = [...new Set(ctx.productByDate.map((d) => d.month))].sort();
      const latest = months[months.length - 1];
      const wantsPrevious = /(last|previous)/.test(monthMatch[1]) && months.length > 1;
      const target = wantsPrevious ? months[months.length - 2] : latest;
      scope = `${target} (${wantsPrevious ? "the month before the latest month in the file" : "the latest month in the file"})`;
      const totals = new Map<string, number>();
      for (const r of ctx.productByDate) if (r.month === target) totals.set(r.name, (totals.get(r.name) ?? 0) + r.value);
      const monthTotal = sum([...totals.values()]);
      items = [...totals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value: round(value), quantity: null, share_pct: monthTotal ? round((value / monthTotal) * 100, 1) : 0 }));
    }
    const lines = items.slice(0, 5).map((t, i) => `${i + 1}. ${t.name}: ${ctx.currency} ${t.value.toLocaleString("en-US")} (${t.share_pct}%)`);
    return { question, text: `Top products by ${ctx.valueLabel.toLowerCase()} for ${scope}:\n${lines.join("\n")}`, source: "computed" };
  }
  if (/(total|overall|sum)/.test(q) && /(revenue|sales|amount)/.test(q)) {
    return { question, text: `Total ${ctx.valueLabel.toLowerCase()}: ${ctx.currency} ${round(ctx.total).toLocaleString("en-US")}.`, source: "computed" };
  }
  if (/(trend|grow|declin|drop|increase|decrease)/.test(q) && ctx.series.length >= 2) {
    const last = ctx.series[ctx.series.length - 1];
    const prev = ctx.series[ctx.series.length - 2];
    const change = pctChange(last.value, prev.value);
    return {
      question,
      text: `Latest ${ctx.granularity} ${last.period}: ${last.value.toLocaleString("en-US")} vs ${prev.period}: ${prev.value.toLocaleString("en-US")} (${change === null ? "n/a" : `${change > 0 ? "+" : ""}${change}%`}).`,
      source: "computed",
    };
  }
  return {
    question,
    text: "This question needs the AI step to answer in natural language. The computed figures below are still available.",
    source: "computed",
  };
}

function buildAiRequest(result: AnalyticsResult, question: string): AiRequest {
  const facts = {
    dataset: result.dataset,
    metrics: result.metrics,
    kpis: result.kpis,
    value_over_time: result.charts.value_over_time.slice(-24),
    top_items: result.charts.top_items,
    by_category: result.charts.by_category,
    anomalies: result.anomalies,
    data_quality: result.data_quality,
    currency: result.currency,
  };
  return {
    system: [
      "You are a business data analyst. You receive figures that were computed from a user's uploaded dataset.",
      GROUNDING_RULES,
      'Respond with a single JSON object: {"summary": string (3-5 sentences), "answer": string | null, "insights": string[] (max 5, each citing a figure)}.',
    ].join("\n"),
    prompt: `Computed figures (JSON):\n${JSON.stringify(facts)}\n\nUser question: ${question || "(none — write the summary and insights only; answer must be null)"}`,
    max_tokens: 2000,
  };
}

/** Merge the model's narrative into the computed result; keep computed text when AI is unavailable. */
export function mergeAnalyticsAi(result: AnalyticsResult, aiResponse: unknown): AnalyticsResult {
  const text = readClaudeText(aiResponse);
  if (!text) return result;
  const parsed = extractJson(text) as { summary?: unknown; answer?: unknown; insights?: unknown } | null;
  if (parsed && typeof parsed.summary === "string") {
    const merged: AnalyticsResult = { ...result, ai_generated: true };
    merged.summary = parsed.summary;
    merged.summary_source = "ai";
    if (Array.isArray(parsed.insights)) {
      const ai = parsed.insights.filter((s): s is string => typeof s === "string").slice(0, 5);
      if (ai.length) merged.insights = ai;
    }
    if (result.answer && typeof parsed.answer === "string" && parsed.answer.trim()) {
      merged.answer = { question: result.answer.question, text: parsed.answer, source: "ai" };
    }
    return merged;
  }
  // Unparseable output: keep the computed summary rather than show raw model text.
  return result;
}
