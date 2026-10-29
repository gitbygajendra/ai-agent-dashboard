import { describe, expect, it } from "vitest";
import { analyzeDataset, mergeAnalyticsAi, type AnalyticsInput, type AnalyticsResult } from "@/lib/agents/logic/analytics";
import type { LogicOutput } from "@/lib/agents/logic/common";

function unwrap<R>(out: LogicOutput<R>) {
  if (!out.ok) throw new Error(`expected ok, got ${out.error.code}: ${out.error.message}`);
  return out;
}

function claudeText(text: string, stop_reason = "end_turn") {
  return { id: "msg_1", type: "message", role: "assistant", stop_reason, content: [{ type: "text", text }] };
}

/**
 * Hand-computed fixture (9 rows, 2026-03-01 .. 2026-09-20, span 203 days → monthly):
 *   total = 1650, avg = 183.33, customers = 5 (alice, bob, carol, dave, erin)
 *   Gadget 750 (45.5%), Widget 500 (30.3%), Gizmo 400 (24.2%)
 *   months: 03=100 04=200 05=100 06=100 07=200 08=500 09=450 → latest change -10%
 *   2026-09 only: Gizmo 300 (66.7%), Gadget 150 (33.3%)
 *   2026-08 only: Gadget 400 (80%), Widget 100 (20%)
 *   regions: South 850, North 800
 */
const SALES: AnalyticsInput = {
  dataset: {
    name: "sales.csv",
    columns: ["Order Date", "Product", "Customer", "Revenue", "Region"],
    rows: [
      { "Order Date": "2026-03-01", Product: "Widget", Customer: "alice", Revenue: "100", Region: "North" },
      { "Order Date": "2026-04-15", Product: "Gadget", Customer: "bob", Revenue: "200", Region: "South" },
      { "Order Date": "2026-05-20", Product: "Widget", Customer: "carol", Revenue: "100", Region: "North" },
      { "Order Date": "2026-06-10", Product: "Gizmo", Customer: "alice", Revenue: "100", Region: "South" },
      { "Order Date": "2026-07-05", Product: "Widget", Customer: "dave", Revenue: "200", Region: "North" },
      { "Order Date": "2026-08-12", Product: "Gadget", Customer: "bob", Revenue: "400", Region: "South" },
      { "Order Date": "2026-08-25", Product: "Widget", Customer: "Alice", Revenue: "100", Region: "North" },
      { "Order Date": "2026-09-03", Product: "Gizmo", Customer: "erin", Revenue: "300", Region: "North" },
      { "Order Date": "2026-09-20", Product: "Gadget", Customer: "carol", Revenue: "150", Region: "South" },
    ],
  },
  currency: "USD",
};

describe("analyzeDataset: column detection", () => {
  it("detects date, revenue, product, customer and category columns", () => {
    const { result } = unwrap(analyzeDataset(SALES));
    expect(result.dataset.detected).toMatchObject({
      date: "Order Date",
      revenue: "Revenue",
      product: "Product",
      customer: "Customer",
      category: "Region",
      value: "Revenue",
    });
    expect(result.dataset.value_label).toBe("Revenue");
    expect(result.dataset.row_count).toBe(9);
    expect(result.dataset.column_count).toBe(5);
  });

  it("derives revenue from quantity × unit price when there is no revenue column", () => {
    const { result } = unwrap(
      analyzeDataset({
        dataset: {
          name: "items.csv",
          columns: ["Date", "Item", "Qty", "Unit Price"],
          rows: [
            { Date: "2026-09-01", Item: "A", Qty: "2", "Unit Price": "10" },
            { Date: "2026-09-02", Item: "B", Qty: "3", "Unit Price": "5" },
            { Date: "2026-09-03", Item: "A", Qty: "1", "Unit Price": "10" },
          ],
        },
      }),
    );
    expect(result.dataset.detected.revenue).toBeNull();
    expect(result.dataset.detected.quantity).toBe("Qty");
    expect(result.dataset.detected.price).toBe("Unit Price");
    expect(result.dataset.detected.product).toBe("Item");
    expect(result.dataset.value_label).toBe("Revenue (quantity × price)");
    // 2*10 + 3*5 + 1*10 = 45
    expect(result.metrics.revenue_total).toBe(45);
    expect(result.charts.top_items).toEqual([
      { name: "A", value: 30, quantity: 3, share_pct: 66.7 },
      { name: "B", value: 15, quantity: 3, share_pct: 33.3 },
    ]);
  });

  it("parses dd/mm/yyyy dates when any value has a day > 12", () => {
    const { result } = unwrap(
      analyzeDataset({
        dataset: {
          name: "dmy.csv",
          columns: ["Date", "Sales"],
          rows: [
            { Date: "05/04/2026", Sales: "10" }, // ambiguous on its own
            { Date: "13/04/2026", Sales: "20" }, // proves day-first
            { Date: "01/05/2026", Sales: "30" },
          ],
        },
      }),
    );
    expect(result.dataset.detected.date).toBe("Date");
    // 05/04 must be 5 April (day-first), not 4 May.
    expect(result.dataset.date_range).toEqual({ start: "2026-04-05", end: "2026-05-01" });
    expect(result.charts.granularity).toBe("day");
    expect(result.charts.value_over_time.map((p) => p.period)).toEqual(["2026-04-05", "2026-04-13", "2026-05-01"]);
  });
});

describe("analyzeDataset: KPIs, totals, top products and series", () => {
  const { result } = unwrap(analyzeDataset(SALES));

  it("computes totals and KPIs", () => {
    expect(result.metrics).toEqual({
      revenue_total: 1650,
      order_count: 9,
      avg_order_value: 183.33,
      unique_customers: 5, // "Alice" and "alice" are the same customer
      unique_products: 3,
      period_change_pct: -10,
    });
    const kpi = Object.fromEntries(result.kpis.map((k) => [k.key, k]));
    expect(kpi.total).toMatchObject({ value: 1650, format: "currency", change_pct: -10 });
    expect(kpi.rows.value).toBe(9);
    expect(kpi.average).toMatchObject({ value: 183.33, format: "currency" });
    expect(kpi.customers.value).toBe(5);
    expect(kpi.products.value).toBe(3);
    expect(kpi.top_item).toMatchObject({ value: "Gadget", format: "text", note: "45.5% of total" });
  });

  it("ranks top products with share of total", () => {
    expect(result.charts.top_items).toEqual([
      { name: "Gadget", value: 750, quantity: null, share_pct: 45.5 },
      { name: "Widget", value: 500, quantity: null, share_pct: 30.3 },
      { name: "Gizmo", value: 400, quantity: null, share_pct: 24.2 },
    ]);
    expect(result.charts.by_category).toEqual([
      { name: "South", value: 850 },
      { name: "North", value: 800 },
    ]);
  });

  it("builds a monthly series and the latest period change", () => {
    expect(result.charts.granularity).toBe("month");
    expect(result.dataset.date_range).toEqual({ start: "2026-03-01", end: "2026-09-20" });
    expect(result.charts.value_over_time).toEqual([
      { period: "2026-03", value: 100 },
      { period: "2026-04", value: 200 },
      { period: "2026-05", value: 100 },
      { period: "2026-06", value: 100 },
      { period: "2026-07", value: 200 },
      { period: "2026-08", value: 500 },
      { period: "2026-09", value: 450 },
    ]);
    expect(result.metrics.period_change_pct).toBe(-10);
    expect(result.opportunities.some((o) => o.includes("down 10%"))).toBe(true);
    expect(result.anomalies).toEqual([]);
  });

  it("produces computed summary text and an AI request grounded in the figures", () => {
    expect(result.summary_source).toBe("computed");
    expect(result.ai_generated).toBe(false);
    expect(result.summary).toContain("USD 1,650");
    const { ai_request } = unwrap(analyzeDataset(SALES));
    expect(ai_request).not.toBeNull();
    expect(ai_request!.prompt).toContain('"revenue_total":1650');
  });
});

describe("analyzeDataset: questions", () => {
  it('answers "highest revenue this month" for the latest month in the data, not the whole file', () => {
    const { result } = unwrap(analyzeDataset({ ...SALES, question: "Which products generated the highest revenue this month?" }));
    expect(result.answer).not.toBeNull();
    const text = result.answer!.text;
    expect(result.answer!.source).toBe("computed");
    expect(text).toContain("2026-09");
    expect(text).toContain("latest month in the file");
    const lines = text.split("\n").slice(1);
    expect(lines).toEqual(["1. Gizmo: USD 300 (66.7%)", "2. Gadget: USD 150 (33.3%)"]);
    // Widget had no sales in 2026-09 and must not appear; overall leader Gadget is second here.
    expect(text).not.toContain("Widget");
  });

  it('answers "last month" with the month before the latest one', () => {
    const { result } = unwrap(analyzeDataset({ ...SALES, question: "What were the top products last month?" }));
    const text = result.answer!.text;
    expect(text).toContain("2026-08");
    expect(text.split("\n").slice(1)).toEqual(["1. Gadget: USD 400 (80%)", "2. Widget: USD 100 (20%)"]);
  });

  it("answers top products without a month scope from the whole dataset", () => {
    const { result } = unwrap(analyzeDataset({ ...SALES, question: "What are the best selling products?" }));
    expect(result.answer!.text).toContain("the whole dataset");
    expect(result.answer!.text.split("\n")[1]).toBe("1. Gadget: USD 750 (45.5%)");
  });

  it("answers total revenue", () => {
    const { result } = unwrap(analyzeDataset({ ...SALES, question: "What is the total revenue?" }));
    expect(result.answer!.text).toBe("Total revenue: USD 1,650.");
  });

  it("has no answer when no question is asked", () => {
    const { result } = unwrap(analyzeDataset(SALES));
    expect(result.answer).toBeNull();
  });
});

describe("analyzeDataset: anomalies", () => {
  it("flags negative values with their spreadsheet row numbers", () => {
    const { result } = unwrap(
      analyzeDataset({
        dataset: {
          name: "refunds.csv",
          columns: ["Product", "Revenue"],
          rows: [
            { Product: "A", Revenue: "100" },
            { Product: "B", Revenue: "-40" },
            { Product: "C", Revenue: "60" },
            { Product: "A", Revenue: "(25)" },
          ],
        },
      }),
    );
    const neg = result.anomalies.find((a) => a.type === "negative_values");
    expect(neg).toBeDefined();
    // header = row 1, first data row = row 2 → rows 3 and 5
    expect(neg!.rows).toEqual([3, 5]);
    expect(neg!.description).toContain("2 row(s)");
    expect(result.metrics.revenue_total).toBe(95);
  });
});

describe("analyzeDataset: failures", () => {
  it("EMPTY_DATASET when there are no rows", () => {
    const out = analyzeDataset({ dataset: { name: "e.csv", columns: ["Revenue"], rows: [] } });
    expect(out).toMatchObject({ ok: false, error: { code: "EMPTY_DATASET" } });
  });

  it("NO_NUMERIC_COLUMN when no column is numeric", () => {
    const out = analyzeDataset({
      dataset: {
        name: "text.csv",
        columns: ["Name", "City"],
        rows: [
          { Name: "Asha", City: "Pune" },
          { Name: "Ben", City: "Delhi" },
        ],
      },
    });
    expect(out).toMatchObject({ ok: false, error: { code: "NO_NUMERIC_COLUMN" } });
  });

  it.each([
    ["missing input", undefined],
    ["missing dataset", {}],
    ["rows not an array", { dataset: { name: "x", columns: ["a"], rows: "nope" } }],
    ["columns not an array", { dataset: { name: "x", columns: null, rows: [{ a: 1 }] } }],
  ])("INVALID_INPUT for malformed input (%s)", (_label, input) => {
    const out = analyzeDataset(input as unknown as AnalyticsInput);
    expect(out).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("NO_HEADERS when every column name is blank", () => {
    const out = analyzeDataset({ dataset: { name: "x", columns: ["", "  "], rows: [{ "": 1 }] } });
    expect(out).toMatchObject({ ok: false, error: { code: "NO_HEADERS" } });
  });
});

describe("mergeAnalyticsAi", () => {
  const base = (): AnalyticsResult =>
    unwrap(analyzeDataset({ ...SALES, question: "Which products generated the highest revenue this month?" })).result;

  it("merges a valid Claude JSON response", () => {
    const computed = base();
    const merged = mergeAnalyticsAi(
      computed,
      claudeText(
        "```json\n" +
          JSON.stringify({ summary: "Revenue was USD 1,650.", answer: "Gizmo led September.", insights: ["Gadget is 45.5% of revenue", 42, "Sept fell 10%"] }) +
          "\n```",
      ),
    );
    expect(merged.ai_generated).toBe(true);
    expect(merged.summary).toBe("Revenue was USD 1,650.");
    expect(merged.summary_source).toBe("ai");
    expect(merged.insights).toEqual(["Gadget is 45.5% of revenue", "Sept fell 10%"]);
    expect(merged.answer).toEqual({ question: computed.answer!.question, text: "Gizmo led September.", source: "ai" });
    // Computed figures are untouched.
    expect(merged.metrics).toEqual(computed.metrics);
    expect(merged.charts).toEqual(computed.charts);
  });

  it("keeps the computed result on a refusal", () => {
    const computed = base();
    const merged = mergeAnalyticsAi(computed, claudeText("I can't help with that.", "refusal"));
    expect(merged).toEqual(computed);
    expect(merged.summary_source).toBe("computed");
    expect(merged.ai_generated).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "garbage"],
    ["a number", 42],
    ["an unrelated object", { foo: "bar" }],
    ["content that is not an array", { content: "text" }],
    ["an API error object", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ["empty text blocks", { stop_reason: "end_turn", content: [{ type: "text", text: "   " }] }],
    ["only non-text blocks", { stop_reason: "end_turn", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }],
  ])("keeps the computed summary when the AI response is garbage (%s)", (_label, garbage) => {
    const computed = base();
    const merged = mergeAnalyticsAi(computed, garbage);
    expect(merged.summary).toBe(computed.summary);
    expect(merged.summary_source).toBe("computed");
    expect(merged.insights).toEqual(computed.insights);
    expect(merged.answer).toEqual(computed.answer);
    expect(merged.ai_generated).toBe(false);
  });

  // Regression (fixed): when the model's text is not
  // parseable JSON (e.g. output cut off at max_tokens), the raw text — including a
  // half-written JSON object — replaces the computed summary and is labelled "ai".
  it("keeps the computed summary when the model returns truncated/unparseable JSON", () => {
    const computed = base();
    const merged = mergeAnalyticsAi(computed, claudeText('{"summary": "Revenue was USD 1,6', "max_tokens"));
    expect(merged.summary).toBe(computed.summary);
    expect(merged.summary_source).toBe("computed");
  });
});
