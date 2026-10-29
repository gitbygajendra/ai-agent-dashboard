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
  median,
  parseDate,
  parseNumber,
  pipelineOutput,
  readClaudeText,
  round,
  runStages,
  stdDev,
  truncate,
} from "./common";

export type Table = { name: string; columns: string[]; rows: Row[] };

export type FinanceInput = {
  transactions: Table;
  invoices?: Table | null;
  currency?: string;
  options?: { date_window_days?: number; amount_tolerance?: number };
};

export type SourceRef = { file: string; rows: number[] };

export type Finding = {
  id: string;
  type: "duplicate" | "unusual_expense" | "missing_payment" | "amount_mismatch" | "matched_by_amount" | "invalid_row";
  severity: "high" | "medium" | "low";
  description: string;
  amount: number | null;
  reference: string | null;
  sources: SourceRef[];
};

export type FinanceResult = {
  summary: {
    income_total: number;
    expense_total: number;
    net_profit: number;
    transaction_count: number;
    invoice_count: number;
    period: { start: string; end: string } | null;
  };
  monthly: { month: string; income: number; expense: number; net: number }[];
  categories: { category: string; type: "income" | "expense"; total: number; count: number }[];
  findings: Finding[];
  reconciliation: { invoices: number; matched_by_reference: number; matched_by_amount: number; missing_payments: number; mismatched: number } | null;
  detected_columns: { transactions: Record<string, string | null>; invoices: Record<string, string | null> | null };
  explanation: string;
  explanation_source: "computed" | "ai";
  disclaimer: string;
  ai_generated: boolean;
  currency: string;
};

type Txn = {
  row: number;
  date: string | null;
  amount: number; // signed: + income, - expense
  description: string;
  reference: string;
  counterparty: string;
  category: string;
};

const CATEGORY_RULES: [string, RegExp][] = [
  ["Payroll", /(salary|payroll|wages|stipend)/i],
  ["Rent", /\brent\b|lease/i],
  ["Software & subscriptions", /(software|subscription|saas|aws|azure|google workspace|gsuite|microsoft|slack|notion|zoom|github|figma|adobe|hosting)/i],
  ["Marketing", /(marketing|ads\b|advert|facebook|meta ads|google ads|linkedin|campaign|promotion)/i],
  ["Travel", /(travel|flight|airline|hotel|uber|ola|taxi|cab|train|fuel|petrol)/i],
  ["Utilities", /(electric|utility|water bill|internet|broadband|phone|mobile|telecom)/i],
  ["Office & supplies", /(office|supplies|stationery|printer|furniture)/i],
  ["Taxes", /(\btax\b|gst|vat|tds|income tax)/i],
  ["Bank fees", /(bank charge|bank fee|service charge|\bfee\b|commission|interest charged)/i],
  ["Professional services", /(consult|legal|lawyer|accountant|audit fee|freelanc|contractor)/i],
  ["Inventory & COGS", /(inventory|stock purchase|raw material|supplier|wholesale|cogs)/i],
  ["Sales income", /(invoice|payment received|sale|customer payment|receipt|deposit)/i],
];

function categorize(description: string, counterparty: string, isIncome: boolean): string {
  const text = `${description} ${counterparty}`;
  for (const [name, re] of CATEGORY_RULES) if (re.test(text)) return name;
  return isIncome ? "Other income" : "Uncategorized expense";
}

function normRef(v: unknown): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^0+/, "");
}

function detectTxnColumns(columns: string[]) {
  const date = findColumn(columns, [/^(txn_|transaction_|value_|posting_)?date$/, /date/]);
  const debit = findColumn(columns, [/^debit/, /withdrawal/, /^dr$/, /paid_out/, /money_out/]);
  const credit = findColumn(columns, [/^credit/, /deposit/, /^cr$/, /paid_in/, /money_in/]);
  const amount = findColumn(columns, [/^amount$/, /amount/, /^value$/, /^total$/], [debit ?? "", credit ?? ""]);
  const type = findColumn(columns, [/^type$/, /txn_type/, /transaction_type/, /dr_cr/, /direction/]);
  const description = findColumn(columns, [/description/, /narration/, /memo/, /details/, /particulars/, /^note/]);
  const reference = findColumn(columns, [/invoice/, /reference/, /^ref/, /txn_id/, /transaction_id/, /cheque/, /utr/]);
  const counterparty = findColumn(columns, [/vendor/, /payee/, /customer/, /party/, /merchant/, /counterparty/, /^name$/]);
  const category = findColumn(columns, [/category/, /account/, /ledger/, /head/]);
  return { date, amount, debit, credit, type, description, reference, counterparty, category };
}

function detectInvoiceColumns(columns: string[]) {
  const number = findColumn(columns, [/^invoice(_no|_number|_id)?$/, /invoice/, /^inv/, /^number$/, /^ref/, /^id$/]);
  const date = findColumn(columns, [/^invoice_date$/, /^date$/, /issue/, /date/]);
  const amount = findColumn(columns, [/^amount$/, /total/, /amount/, /due/, /value/]);
  const customer = findColumn(columns, [/customer/, /client/, /bill_to/, /party/, /^name$/]);
  return { number, date, amount, customer };
}

export type FinanceState = {
  input: FinanceInput;
  currency?: string;
  windowDays?: number;
  tolerance?: number;
  tc?: ReturnType<typeof detectTxnColumns>;
  dayFirst?: boolean;
  txns?: Txn[];
  findings?: Finding[];
  findingSeq?: number;
  reconciliation?: FinanceResult["reconciliation"];
  invoiceColumns?: Record<string, string | null> | null;
  output?: LogicOutput<FinanceResult>;
};

const nextId = (seq: number) => `F-${String(seq).padStart(3, "0")}`;

// Stage order matters: findings get sequential ids in insertion order, then a
// stable sort by severity, so duplicates → unusual → reconciliation must stay.
export const FINANCE_STAGES: Stage<FinanceState>[] = [
  {
    name: "detect columns",
    run(s) {
      const t = s.input?.transactions;
      if (!t || !Array.isArray(t.rows) || !Array.isArray(t.columns)) return { ...s, output: fail("INVALID_INPUT", "A transactions file is required.") };
      if (!t.rows.length) return { ...s, output: fail("EMPTY_DATASET", "The transactions file has no rows.") };
      const tc = detectTxnColumns(t.columns);
      if (!tc.amount && !(tc.debit || tc.credit)) {
        return { ...s, output: fail("NO_AMOUNT_COLUMN", 'Could not find an amount column (expected "amount", or "debit"/"credit").') };
      }
      return {
        ...s,
        currency: s.input.currency || "USD",
        windowDays: s.input.options?.date_window_days ?? 7,
        tolerance: s.input.options?.amount_tolerance ?? 0.01,
        tc,
        dayFirst: tc.date ? detectDayFirst(t.rows.slice(0, 500).map((r) => r[tc.date!])) : false,
        findings: [],
        findingSeq: 0,
      };
    },
  },
  {
    name: "categorize transactions",
    run(s) {
      const t = s.input.transactions;
      const tc = s.tc!;
      const invalidRows: number[] = [];
      const txns: Txn[] = [];
      t.rows.forEach((r, i) => {
        const rowNo = i + 2;
        let amount: number | null = null;
        if (tc.debit || tc.credit) {
          const d = tc.debit ? parseNumber(r[tc.debit]) : null;
          const c = tc.credit ? parseNumber(r[tc.credit]) : null;
          if (d || c) amount = (c ?? 0) - Math.abs(d ?? 0);
        }
        if (amount === null && tc.amount) {
          amount = parseNumber(r[tc.amount]);
          if (amount !== null && tc.type) {
            const kind = String(r[tc.type] ?? "").toLowerCase();
            if (/(expense|debit|dr|out|payment made|withdraw)/.test(kind)) amount = -Math.abs(amount);
            else if (/(income|credit|cr|in|receipt|deposit|sale)/.test(kind)) amount = Math.abs(amount);
          }
        }
        if (amount === null) {
          invalidRows.push(rowNo);
          return;
        }
        const description = String(tc.description ? r[tc.description] ?? "" : "").trim();
        const counterparty = String(tc.counterparty ? r[tc.counterparty] ?? "" : "").trim();
        const explicitCategory = tc.category ? String(r[tc.category] ?? "").trim() : "";
        txns.push({
          row: rowNo,
          date: tc.date ? parseDate(r[tc.date], s.dayFirst) : null,
          amount,
          description,
          reference: tc.reference ? String(r[tc.reference] ?? "").trim() : "",
          counterparty,
          category: explicitCategory || categorize(description, counterparty, amount > 0),
        });
      });
      if (!txns.length) return { ...s, output: fail("NO_VALID_VALUES", "No transaction rows had a readable amount.") };
      const findings = [...s.findings!];
      let seq = s.findingSeq!;
      if (invalidRows.length) {
        findings.push({
          id: nextId(++seq),
          type: "invalid_row",
          severity: "low",
          description: `${invalidRows.length} transaction row(s) had no readable amount and were excluded from totals.`,
          amount: null,
          reference: null,
          sources: [{ file: t.name, rows: invalidRows.slice(0, 100) }],
        });
      }
      return { ...s, txns, findings, findingSeq: seq };
    },
  },
  {
    name: "find duplicates",
    run(s) {
      const { txns, currency } = s as Required<Pick<FinanceState, "txns" | "currency">>;
      const file = s.input.transactions.name;
      const findings = [...s.findings!];
      let seq = s.findingSeq!;
      // Same date, amount, description and counterparty
      const groups = new Map<string, Txn[]>();
      for (const x of txns) {
        const key = [x.date ?? "", x.amount.toFixed(2), x.description.toLowerCase().replace(/\s+/g, " "), x.counterparty.toLowerCase()].join("|");
        const g = groups.get(key) ?? [];
        g.push(x);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        findings.push({
          id: nextId(++seq),
          type: "duplicate",
          severity: "high",
          description: `Possible duplicate: ${g.length} transactions on ${g[0].date ?? "(no date)"} for ${currency} ${Math.abs(g[0].amount).toLocaleString("en-US")}${g[0].description ? ` — "${truncate(g[0].description, 60)}"` : ""}.`,
          amount: Math.abs(g[0].amount),
          reference: g[0].reference || null,
          sources: [{ file, rows: g.map((x) => x.row) }],
        });
      }
      // Same non-empty reference used by more than one transaction with different dates/amounts
      const byRef = new Map<string, Txn[]>();
      for (const x of txns) {
        const r = normRef(x.reference);
        if (!r) continue;
        const g = byRef.get(r) ?? [];
        g.push(x);
        byRef.set(r, g);
      }
      for (const [ref, g] of byRef) {
        if (g.length < 2) continue;
        const alreadyFlagged = findings.some((f) => f.type === "duplicate" && g.every((x) => f.sources[0].rows.includes(x.row)));
        if (alreadyFlagged) continue;
        findings.push({
          id: nextId(++seq),
          type: "duplicate",
          severity: "medium",
          description: `Reference "${g[0].reference}" appears on ${g.length} transactions. Check whether the same payment was recorded twice.`,
          amount: null,
          reference: ref,
          sources: [{ file, rows: g.map((x) => x.row) }],
        });
      }
      return { ...s, findings, findingSeq: seq };
    },
  },
  {
    name: "flag unusual expenses",
    run(s) {
      const { txns, currency } = s as Required<Pick<FinanceState, "txns" | "currency">>;
      const file = s.input.transactions.name;
      const findings = [...s.findings!];
      let seq = s.findingSeq!;
      const expenses = txns.filter((x) => x.amount < 0);
      // Per category (needs history) and globally
      const expByCat = new Map<string, Txn[]>();
      for (const x of expenses) {
        const g = expByCat.get(x.category) ?? [];
        g.push(x);
        expByCat.set(x.category, g);
      }
      const flaggedUnusual = new Set<number>();
      for (const [cat, g] of expByCat) {
        if (g.length < 5) continue;
        const amounts = g.map((x) => Math.abs(x.amount));
        const med = median(amounts);
        const m = mean(amounts);
        const sd = stdDev(amounts);
        for (const x of g) {
          const a = Math.abs(x.amount);
          if (med > 0 && a >= med * 3 && a > m + 2 * sd) {
            flaggedUnusual.add(x.row);
            findings.push({
              id: nextId(++seq),
              type: "unusual_expense",
              severity: "medium",
              description: `Unusually large ${cat} expense: ${currency} ${a.toLocaleString("en-US")} vs a typical ${currency} ${round(med).toLocaleString("en-US")} in this category.`,
              amount: a,
              reference: x.reference || null,
              sources: [{ file, rows: [x.row] }],
            });
          }
        }
      }
      if (expenses.length >= 10) {
        const amounts = expenses.map((x) => Math.abs(x.amount));
        const m = mean(amounts);
        const sd = stdDev(amounts);
        for (const x of expenses) {
          const a = Math.abs(x.amount);
          if (sd > 0 && a > m + 3 * sd && !flaggedUnusual.has(x.row)) {
            findings.push({
              id: nextId(++seq),
              type: "unusual_expense",
              severity: "low",
              description: `Expense of ${currency} ${a.toLocaleString("en-US")} is more than 3 standard deviations above the average expense (${currency} ${round(m).toLocaleString("en-US")}).`,
              amount: a,
              reference: x.reference || null,
              sources: [{ file, rows: [x.row] }],
            });
          }
        }
      }
      return { ...s, findings, findingSeq: seq };
    },
  },
  {
    name: "reconcile invoices",
    run(s) {
      const { txns, currency, windowDays, tolerance } = s as Required<Pick<FinanceState, "txns" | "currency" | "windowDays" | "tolerance">>;
      const file = s.input.transactions.name;
      const inv = s.input.invoices;
      if (!(inv && Array.isArray(inv.rows) && inv.rows.length)) return { ...s, reconciliation: null, invoiceColumns: null };
      const ic = detectInvoiceColumns(inv.columns);
      if (!ic.amount) return { ...s, output: fail("NO_INVOICE_AMOUNT", 'Could not find an amount column in the invoices file (expected "amount" or "total").') };
      const findings = [...s.findings!];
      let seq = s.findingSeq!;
      const income = txns.filter((x) => x.amount > 0);
      const invDayFirst = ic.date ? detectDayFirst(inv.rows.slice(0, 500).map((r) => r[ic.date!])) : false;
      const used = new Set<number>();
      let byReference = 0;
      let byAmount = 0;
      let missing = 0;
      let mismatched = 0;
      const incomeByRef = new Map<string, Txn[]>();
      for (const x of income) {
        const keys = new Set([normRef(x.reference), ...(x.description.toUpperCase().match(/[A-Z]*-?\d{3,}/g) ?? []).map(normRef)]);
        for (const k of keys) {
          if (!k) continue;
          const g = incomeByRef.get(k) ?? [];
          g.push(x);
          incomeByRef.set(k, g);
        }
      }
      inv.rows.forEach((r, i) => {
        const rowNo = i + 2;
        const number = ic.number ? String(r[ic.number] ?? "").trim() : "";
        const amount = parseNumber(r[ic.amount!]);
        const date = ic.date ? parseDate(r[ic.date], invDayFirst) : null;
        const customer = ic.customer ? String(r[ic.customer] ?? "").trim() : "";
        if (amount === null) {
          findings.push({ id: nextId(++seq), type: "invalid_row", severity: "low", description: `Invoice ${number || `row ${rowNo}`} has no readable amount.`, amount: null, reference: number || null, sources: [{ file: inv.name, rows: [rowNo] }] });
          return;
        }
        const label = number ? `Invoice ${number}` : `Invoice on row ${rowNo}`;
        const refMatches = (number ? incomeByRef.get(normRef(number)) ?? [] : []).filter((x) => !used.has(x.row));
        if (refMatches.length) {
          const paid = round(refMatches.reduce((a, x) => a + x.amount, 0));
          refMatches.forEach((x) => used.add(x.row));
          if (Math.abs(paid - amount) > Math.max(tolerance, Math.abs(amount) * 0.0001)) {
            mismatched++;
            findings.push({
              id: nextId(++seq),
              type: "amount_mismatch",
              severity: "high",
              description: `${label}${customer ? ` (${customer})` : ""}: invoiced ${currency} ${amount.toLocaleString("en-US")} but payments referencing it total ${currency} ${paid.toLocaleString("en-US")} (difference ${currency} ${round(paid - amount).toLocaleString("en-US")}).`,
              amount,
              reference: number || null,
              sources: [{ file: inv.name, rows: [rowNo] }, { file, rows: refMatches.map((x) => x.row) }],
            });
          } else {
            byReference++;
          }
          return;
        }
        const candidates = income.filter((x) => {
          if (used.has(x.row) || Math.abs(x.amount - amount) > tolerance) return false;
          if (!date || !x.date) return true;
          const diff = (Date.parse(x.date) - Date.parse(date)) / 86400000;
          return diff >= -windowDays && diff <= 90;
        });
        if (candidates.length) {
          const match = candidates[0];
          used.add(match.row);
          byAmount++;
          findings.push({
            id: nextId(++seq),
            type: "matched_by_amount",
            severity: "low",
            description: `${label} matched to a payment by amount and date only (no shared reference). Confirm it is the right payment.`,
            amount,
            reference: number || null,
            sources: [{ file: inv.name, rows: [rowNo] }, { file, rows: [match.row] }],
          });
          return;
        }
        missing++;
        findings.push({
          id: nextId(++seq),
          type: "missing_payment",
          severity: "high",
          description: `${label}${customer ? ` (${customer})` : ""} for ${currency} ${amount.toLocaleString("en-US")}${date ? ` dated ${date}` : ""} has no matching payment in the transactions file.`,
          amount,
          reference: number || null,
          sources: [{ file: inv.name, rows: [rowNo] }],
        });
      });
      return {
        ...s,
        findings,
        findingSeq: seq,
        invoiceColumns: ic,
        reconciliation: { invoices: inv.rows.length, matched_by_reference: byReference, matched_by_amount: byAmount, missing_payments: missing, mismatched },
      };
    },
  },
  {
    name: "monthly summary",
    run(s) {
      const { txns, currency } = s as Required<Pick<FinanceState, "txns" | "currency">>;
      const income = txns.filter((x) => x.amount > 0);
      const expenses = txns.filter((x) => x.amount < 0);
      const incomeTotal = round(income.reduce((a, x) => a + x.amount, 0));
      const expenseTotal = round(Math.abs(expenses.reduce((a, x) => a + x.amount, 0)));
      const months = new Map<string, { income: number; expense: number }>();
      for (const x of txns) {
        if (!x.date) continue;
        const m = x.date.slice(0, 7);
        const e = months.get(m) ?? { income: 0, expense: 0 };
        if (x.amount > 0) e.income += x.amount;
        else e.expense += Math.abs(x.amount);
        months.set(m, e);
      }
      const monthly = [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, e]) => ({ month, income: round(e.income), expense: round(e.expense), net: round(e.income - e.expense) }));
      const catMap = new Map<string, { type: "income" | "expense"; total: number; count: number }>();
      for (const x of txns) {
        const type = x.amount > 0 ? "income" : "expense";
        const key = `${type}:${x.category}`;
        const e = catMap.get(key) ?? { type, total: 0, count: 0 };
        e.total += Math.abs(x.amount);
        e.count++;
        catMap.set(key, e);
      }
      const categories = [...catMap.entries()]
        .map(([key, e]) => ({ category: key.split(":").slice(1).join(":"), type: e.type, total: round(e.total), count: e.count }))
        .sort((a, b) => b.total - a.total);
      const dates = txns.map((x) => x.date).filter((d): d is string => Boolean(d)).sort();

      const severityRank = { high: 0, medium: 1, low: 2 };
      const findings = [...s.findings!].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
      const reconciliation = s.reconciliation ?? null;
      const result: FinanceResult = {
        summary: {
          income_total: incomeTotal,
          expense_total: expenseTotal,
          net_profit: round(incomeTotal - expenseTotal),
          transaction_count: txns.length,
          invoice_count: s.input.invoices?.rows?.length ?? 0,
          period: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
        },
        monthly,
        categories,
        findings,
        reconciliation,
        detected_columns: { transactions: s.tc!, invoices: s.invoiceColumns ?? null },
        explanation: computedExplanation(incomeTotal, expenseTotal, findings, reconciliation, currency),
        explanation_source: "computed",
        disclaimer:
          "This is an automated review, not a formal audit. Every flag points to the source rows it came from and needs to be verified by a person before you act on it.",
        ai_generated: false,
        currency,
      };
      return { ...s, output: { ok: true, result, ai_request: buildAiRequest(result) } };
    },
  },
];

export function auditFinance(input: FinanceInput): LogicOutput<FinanceResult> {
  return pipelineOutput(runStages(FINANCE_STAGES, { input }));
}

function computedExplanation(
  income: number,
  expense: number,
  findings: Finding[],
  rec: FinanceResult["reconciliation"],
  currency: string,
): string {
  const high = findings.filter((f) => f.severity === "high").length;
  const parts = [
    `Income ${currency} ${income.toLocaleString("en-US")}, expenses ${currency} ${expense.toLocaleString("en-US")}, net ${currency} ${round(income - expense).toLocaleString("en-US")}.`,
    `${findings.length} item(s) flagged for review, ${high} high priority.`,
  ];
  if (rec) parts.push(`${rec.invoices} invoices checked: ${rec.matched_by_reference} matched by reference, ${rec.matched_by_amount} by amount/date, ${rec.missing_payments} without payment, ${rec.mismatched} with amount differences.`);
  return parts.join(" ");
}

function buildAiRequest(result: FinanceResult): AiRequest {
  return {
    system: [
      "You explain automated bookkeeping checks to a small-business owner in plain language.",
      GROUNDING_RULES,
      "Refer to findings by their id (e.g. F-002). Do not call this an audit opinion; it is a review that needs human verification.",
      'Respond with JSON: {"explanation": string (4-6 sentences), "next_steps": string[] (max 5)}.',
    ].join("\n"),
    prompt: `Review results (JSON):\n${JSON.stringify({ summary: result.summary, monthly: result.monthly.slice(-12), categories: result.categories.slice(0, 12), findings: result.findings.slice(0, 40), reconciliation: result.reconciliation, currency: result.currency })}`,
    max_tokens: 1500,
  };
}

export function mergeFinanceAi(result: FinanceResult, aiResponse: unknown): FinanceResult {
  const text = readClaudeText(aiResponse);
  if (!text) return result;
  const parsed = extractJson(text) as { explanation?: unknown; next_steps?: unknown } | null;
  if (!parsed || typeof parsed.explanation !== "string") return result;
  const steps = Array.isArray(parsed.next_steps) ? parsed.next_steps.filter((s): s is string => typeof s === "string") : [];
  const explanation = parsed.explanation + (steps.length ? `\n\nNext steps:\n${steps.map((s) => `• ${s}`).join("\n")}` : "");
  return { ...result, explanation, explanation_source: "ai", ai_generated: true };
}

