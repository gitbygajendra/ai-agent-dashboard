import { describe, expect, it } from "vitest";
import { auditFinance, mergeFinanceAi, type Finding, type Table } from "@/lib/agents/logic/finance";
import type { LogicOutput } from "@/lib/agents/logic/common";

function unwrap<R>(out: LogicOutput<R>) {
  if (!out.ok) throw new Error(`expected ok, got ${out.error.code}: ${out.error.message}`);
  return out;
}

/** Spreadsheet row number → data row (header is row 1, first data row is row 2). */
function rowAt(table: Table, rowNo: number) {
  const r = table.rows[rowNo - 2];
  if (!r) throw new Error(`row ${rowNo} does not exist in ${table.name}`);
  return r;
}

// Amount + Type layout.
//   income  = 500 + 300 + 750           = 1550
//   expense = 1000 + 200 + 200 + 2000   = 3400
const TXNS: Table = {
  name: "bank-sept.csv",
  columns: ["Date", "Description", "Amount", "Type", "Vendor", "Reference"],
  rows: [
    /* row 2 */ { Date: "2026-09-01", Description: "Office rent September", Amount: "1000", Type: "Expense", Vendor: "Landlord Co", Reference: "" },
    /* row 3 */ { Date: "2026-09-02", Description: "Payment received INV-1001", Amount: "500", Type: "Income", Vendor: "Acme", Reference: "INV-1001" },
    /* row 4 */ { Date: "2026-09-05", Description: "AWS subscription", Amount: "200", Type: "Expense", Vendor: "Amazon Web Services", Reference: "" },
    /* row 5 */ { Date: "2026-09-05", Description: "AWS subscription", Amount: "200", Type: "Expense", Vendor: "Amazon Web Services", Reference: "" },
    /* row 6 */ { Date: "2026-09-10", Description: "Customer payment", Amount: "300", Type: "Income", Vendor: "Beta Ltd", Reference: "INV-1002" },
    /* row 7 */ { Date: "2026-09-12", Description: "Customer payment", Amount: "750", Type: "Income", Vendor: "Gamma", Reference: "" },
    /* row 8 */ { Date: "2026-09-15", Description: "Salary payout", Amount: "2000", Type: "Expense", Vendor: "Staff", Reference: "" },
  ],
};

const INVOICES: Table = {
  name: "invoices.csv",
  columns: ["Invoice Number", "Invoice Date", "Customer", "Amount"],
  rows: [
    /* row 2 */ { "Invoice Number": "INV-1001", "Invoice Date": "2026-08-30", Customer: "Acme", Amount: "500" }, // matched by reference
    /* row 3 */ { "Invoice Number": "INV-1002", "Invoice Date": "2026-09-01", Customer: "Beta Ltd", Amount: "350" }, // paid 300 → mismatch
    /* row 4 */ { "Invoice Number": "INV-1003", "Invoice Date": "2026-09-10", Customer: "Gamma", Amount: "750" }, // amount/date match → row 7
    /* row 5 */ { "Invoice Number": "INV-1004", "Invoice Date": "2026-09-20", Customer: "Delta", Amount: "999" }, // missing
  ],
};

describe("auditFinance: totals", () => {
  it("computes income/expense with an amount + type column", () => {
    const { result } = unwrap(auditFinance({ transactions: TXNS }));
    expect(result.summary).toEqual({
      income_total: 1550,
      expense_total: 3400,
      net_profit: -1850,
      transaction_count: 7,
      invoice_count: 0,
      period: { start: "2026-09-01", end: "2026-09-15" },
    });
    expect(result.monthly).toEqual([{ month: "2026-09", income: 1550, expense: 3400, net: -1850 }]);
    expect(result.detected_columns.transactions).toMatchObject({ amount: "Amount", type: "Type", description: "Description", reference: "Reference", counterparty: "Vendor" });
  });

  it("computes income/expense with debit/credit columns", () => {
    const bank: Table = {
      name: "statement.csv",
      columns: ["Txn Date", "Narration", "Debit", "Credit", "Balance"],
      rows: [
        { "Txn Date": "2026-09-01", Narration: "Opening deposit", Debit: "", Credit: "5000", Balance: "5000" },
        { "Txn Date": "2026-09-03", Narration: "Google Ads campaign", Debit: "1200", Credit: "", Balance: "3800" },
        { "Txn Date": "2026-09-04", Narration: "Bank charge", Debit: "15.50", Credit: "", Balance: "3784.5" },
        { "Txn Date": "2026-09-06", Narration: "Customer receipt", Debit: "", Credit: "2,500.00", Balance: "6284.5" },
      ],
    };
    const { result } = unwrap(auditFinance({ transactions: bank, currency: "INR" }));
    expect(result.detected_columns.transactions).toMatchObject({ debit: "Debit", credit: "Credit", amount: null, date: "Txn Date", description: "Narration" });
    expect(result.summary.income_total).toBe(7500);
    expect(result.summary.expense_total).toBe(1215.5);
    expect(result.summary.net_profit).toBe(6284.5);
    expect(result.currency).toBe("INR");
    const cats = Object.fromEntries(result.categories.map((c) => [`${c.type}:${c.category}`, c.total]));
    expect(cats).toEqual({
      "income:Sales income": 7500,
      "expense:Marketing": 1200,
      "expense:Bank fees": 15.5,
    });
  });
});

describe("auditFinance: categorization", () => {
  it("assigns rule-based categories by description and counterparty", () => {
    const { result } = unwrap(auditFinance({ transactions: TXNS }));
    expect(result.categories).toEqual([
      { category: "Payroll", type: "expense", total: 2000, count: 1 },
      { category: "Sales income", type: "income", total: 1550, count: 3 },
      { category: "Rent", type: "expense", total: 1000, count: 1 },
      { category: "Software & subscriptions", type: "expense", total: 400, count: 2 },
    ]);
  });

  it("uses an explicit category column when present and falls back for unknown text", () => {
    const { result } = unwrap(
      auditFinance({
        transactions: {
          name: "t.csv",
          columns: ["Date", "Description", "Amount", "Category"],
          rows: [
            { Date: "2026-09-01", Description: "Zxqv", Amount: "-50", Category: "Meals" },
            { Date: "2026-09-02", Description: "Zxqv", Amount: "-20", Category: "" },
            { Date: "2026-09-03", Description: "Zxqv", Amount: "70", Category: "" },
          ],
        },
      }),
    );
    const names = result.categories.map((c) => `${c.type}:${c.category}`).sort();
    expect(names).toEqual(["expense:Meals", "expense:Uncategorized expense", "income:Other income"]);
  });
});

describe("auditFinance: duplicates", () => {
  it("flags same date/amount/description/counterparty as a high-severity duplicate referencing both rows", () => {
    const { result } = unwrap(auditFinance({ transactions: TXNS }));
    const dups = result.findings.filter((f) => f.type === "duplicate");
    expect(dups).toHaveLength(1);
    expect(dups[0].severity).toBe("high");
    expect(dups[0].amount).toBe(200);
    expect(dups[0].sources).toEqual([{ file: "bank-sept.csv", rows: [4, 5] }]);
    for (const n of dups[0].sources[0].rows) expect(rowAt(TXNS, n).Description).toBe("AWS subscription");
  });

  it("flags a reference reused on different transactions (medium)", () => {
    const t: Table = {
      name: "ref.csv",
      columns: ["Date", "Description", "Amount", "Reference"],
      rows: [
        { Date: "2026-09-01", Description: "Payment", Amount: "100", Reference: "UTR-42" },
        { Date: "2026-09-02", Description: "Other", Amount: "5", Reference: "x" },
        { Date: "2026-09-09", Description: "Payment again", Amount: "120", Reference: "utr 42" },
      ],
    };
    const { result } = unwrap(auditFinance({ transactions: t }));
    const dup = result.findings.find((f) => f.type === "duplicate");
    expect(dup).toMatchObject({ severity: "medium", reference: "UTR42", sources: [{ file: "ref.csv", rows: [2, 4] }] });
  });
});

describe("auditFinance: invoice reconciliation", () => {
  const { result } = unwrap(auditFinance({ transactions: TXNS, invoices: INVOICES }));
  const byType = (type: Finding["type"]) => result.findings.filter((f) => f.type === type);

  it("summarizes reconciliation counts", () => {
    expect(result.reconciliation).toEqual({ invoices: 4, matched_by_reference: 1, matched_by_amount: 1, missing_payments: 1, mismatched: 1 });
    expect(result.summary.invoice_count).toBe(4);
    expect(result.detected_columns.invoices).toEqual({ number: "Invoice Number", date: "Invoice Date", amount: "Amount", customer: "Customer" });
  });

  it("does not flag the invoice matched by reference with the right amount", () => {
    expect(result.findings.some((f) => f.reference === "INV-1001")).toBe(false);
  });

  it("flags an amount mismatch (high) pointing at the invoice row and the payment row", () => {
    const [f] = byType("amount_mismatch");
    expect(f).toMatchObject({ severity: "high", amount: 350, reference: "INV-1002" });
    expect(f.description).toContain("difference USD -50");
    expect(f.sources).toEqual([
      { file: "invoices.csv", rows: [3] },
      { file: "bank-sept.csv", rows: [6] },
    ]);
    expect(rowAt(INVOICES, 3)["Invoice Number"]).toBe("INV-1002");
    expect(rowAt(TXNS, 6).Reference).toBe("INV-1002");
  });

  it("matches by amount/date as a low-severity finding", () => {
    const [f] = byType("matched_by_amount");
    expect(f).toMatchObject({ severity: "low", amount: 750, reference: "INV-1003" });
    expect(f.sources).toEqual([
      { file: "invoices.csv", rows: [4] },
      { file: "bank-sept.csv", rows: [7] },
    ]);
    expect(rowAt(INVOICES, 4)["Invoice Number"]).toBe("INV-1003");
    expect(rowAt(TXNS, 7).Amount).toBe("750");
  });

  it("flags a missing payment (high) pointing at the invoice row", () => {
    const [f] = byType("missing_payment");
    expect(f).toMatchObject({ severity: "high", amount: 999, reference: "INV-1004" });
    expect(f.sources).toEqual([{ file: "invoices.csv", rows: [5] }]);
    expect(rowAt(INVOICES, 5)["Invoice Number"]).toBe("INV-1004");
  });

  it("every finding cites existing rows in named files, sorted high → low", () => {
    expect(result.findings.length).toBeGreaterThan(0);
    const files: Record<string, Table> = { [TXNS.name]: TXNS, [INVOICES.name]: INVOICES };
    for (const f of result.findings) {
      expect(f.id).toMatch(/^F-\d{3}$/);
      expect(f.sources.length).toBeGreaterThan(0);
      for (const s of f.sources) {
        expect(Object.keys(files)).toContain(s.file);
        expect(s.rows.length).toBeGreaterThan(0);
        for (const n of s.rows) {
          expect(n).toBeGreaterThanOrEqual(2);
          expect(() => rowAt(files[s.file], n)).not.toThrow();
        }
      }
    }
    const rank = { high: 0, medium: 1, low: 2 };
    const ranks = result.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("does not match a payment that is outside the date window", () => {
    const { result: r } = unwrap(
      auditFinance({
        transactions: {
          name: "t.csv",
          columns: ["Date", "Description", "Amount"],
          rows: [{ Date: "2026-01-01", Description: "Payment", Amount: "750" }],
        },
        invoices: { name: "i.csv", columns: ["Invoice", "Date", "Amount"], rows: [{ Invoice: "A-1", Date: "2026-09-10", Amount: "750" }] },
      }),
    );
    expect(r.reconciliation).toMatchObject({ matched_by_amount: 0, missing_payments: 1 });
  });
});

describe("auditFinance: invalid rows, disclaimer and failures", () => {
  it("reports unreadable amounts as an invalid_row finding with row numbers", () => {
    const t: Table = {
      name: "t.csv",
      columns: ["Date", "Amount"],
      rows: [
        { Date: "2026-09-01", Amount: "100" },
        { Date: "2026-09-02", Amount: "n/a" },
        { Date: "2026-09-03", Amount: "-30" },
      ],
    };
    const { result } = unwrap(auditFinance({ transactions: t }));
    const f = result.findings.find((x) => x.type === "invalid_row");
    expect(f).toMatchObject({ severity: "low", sources: [{ file: "t.csv", rows: [3] }] });
    expect(result.summary).toMatchObject({ income_total: 100, expense_total: 30, transaction_count: 2 });
  });

  it("always includes the not-an-audit disclaimer", () => {
    const { result } = unwrap(auditFinance({ transactions: TXNS, invoices: INVOICES }));
    expect(result.disclaimer).toMatch(/not a formal audit/i);
    expect(result.disclaimer).toMatch(/verified by a person/i);
    expect(result.explanation_source).toBe("computed");
  });

  it("NO_AMOUNT_COLUMN when no amount or debit/credit column exists", () => {
    const out = auditFinance({
      transactions: { name: "t.csv", columns: ["Date", "Description", "Notes"], rows: [{ Date: "2026-09-01", Description: "x", Notes: "y" }] },
    });
    expect(out).toMatchObject({ ok: false, error: { code: "NO_AMOUNT_COLUMN" } });
  });

  it("EMPTY_DATASET and INVALID_INPUT", () => {
    expect(auditFinance({ transactions: { name: "t", columns: ["Amount"], rows: [] } })).toMatchObject({ ok: false, error: { code: "EMPTY_DATASET" } });
    expect(auditFinance({} as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("mergeFinanceAi keeps computed explanation on refusal and uses AI explanation when valid", () => {
    const { result } = unwrap(auditFinance({ transactions: TXNS }));
    expect(mergeFinanceAi(result, { stop_reason: "refusal", content: [{ type: "text", text: "no" }] })).toEqual(result);
    const merged = mergeFinanceAi(result, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ explanation: "Expenses exceed income.", next_steps: ["Check F-001"] }) }],
    });
    expect(merged.explanation).toBe("Expenses exceed income.\n\nNext steps:\n• Check F-001");
    expect(merged.explanation_source).toBe("ai");
    expect(merged.findings).toEqual(result.findings);
    expect(merged.disclaimer).toBe(result.disclaimer);
  });
});
