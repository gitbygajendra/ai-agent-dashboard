/**
 * Shared, dependency-free helpers for agent logic.
 *
 * Everything under src/lib/agents/logic is pure TypeScript with no imports
 * outside this folder. `npm run n8n:build` bundles these modules into the
 * Code nodes of the n8n workflows, so the logic that runs in n8n is the same
 * code the unit tests cover.
 */

export type Row = Record<string, unknown>;

export type LogicError = { code: string; message: string };

export type AiRequest = {
  system: string;
  prompt: string;
  max_tokens: number;
};

export type LogicOutput<R> =
  | { ok: true; result: R; ai_request: AiRequest | null }
  | { ok: false; error: LogicError };

export function fail(code: string, message: string): { ok: false; error: LogicError } {
  return { ok: false, error: { code, message } };
}

/**
 * One visible step of an agent's pipeline. State flows from stage to stage.
 * The first stage that sets `output` (a failure, an early answer such as an
 * escalation, or the final result) ends the pipeline; later stages are
 * skipped. Each stage becomes its own Code node in the n8n workflow.
 */
export type Stage<S extends { output?: LogicOutput<unknown> }> = { name: string; run: (s: S) => S };

export function runStages<S extends { output?: LogicOutput<unknown> }>(stages: Stage<S>[], initial: S): S {
  let s = initial;
  for (const stage of stages) {
    if (s.output) break;
    s = stage.run(s);
  }
  return s;
}

/** Final output of a pipeline; a pipeline whose last stage set nothing is a bug. */
export function pipelineOutput<R>(s: { output?: LogicOutput<R> }): LogicOutput<R> {
  return s.output ?? fail("PROCESSING_ERROR", "The pipeline produced no output.");
}

/** Parse "₹1,234.50", "$ 1,234", "(200.00)", "1.234,5" (best effort) into a number. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,\-eE+]/g, "");
  if (!s || !/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) {
    // Whichever separator comes last is the decimal separator.
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join(".") : parts.join("");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Parse common date formats to YYYY-MM-DD. `dayFirst` resolves 03/04/2026. */
export function parseDate(value: unknown, dayFirst = false): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    // Excel serial date (days since 1899-12-30) in a plausible range.
    if (value > 20000 && value < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12) dayFirst = true;
    else if (b > 12) dayFirst = false;
    if (dayFirst) [a, b] = [b, a];
    return ymd(y, a, b);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /[a-zA-Z]{3}/.test(s)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** Decide whether ambiguous dd/mm vs mm/dd values in a column are day-first. */
export function detectDayFirst(values: unknown[]): boolean {
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}$/.exec(v.trim());
    if (!m) continue;
    if (+m[1] > 12) return true;
    if (+m[2] > 12) return false;
  }
  return false;
}

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Find the first column whose normalized name matches one of the patterns (in priority order). */
export function findColumn(columns: string[], patterns: RegExp[], exclude: string[] = []): string | null {
  for (const p of patterns) {
    const hit = columns.find((c) => !exclude.includes(c) && p.test(normalizeHeader(c)));
    if (hit) return hit;
  }
  return null;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Extract the first JSON object from model text (tolerates code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Pull the text out of an Anthropic Messages or OpenAI-style chat (Groq) response; null on error/refusal/truncation. */
export function readClaudeText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const chat = response as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
  if (Array.isArray(chat.choices)) {
    const c = chat.choices[0];
    if (!c || c.finish_reason === "length" || typeof c.message?.content !== "string") return null;
    return c.message.content.trim() || null;
  }
  const r = response as { stop_reason?: string; content?: { type: string; text?: string }[]; error?: unknown };
  // Refusals and truncated (max_tokens) answers are treated as "no AI output".
  if (r.error || r.stop_reason === "refusal" || r.stop_reason === "max_tokens" || !Array.isArray(r.content)) return null;
  const text = r.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

export const GROUNDING_RULES = [
  "Use only the figures and records provided in the input. Never invent numbers, records, customers, transactions or policies.",
  "If the provided data cannot answer something, say so plainly and name the data that would be needed.",
  "Clearly separate verified figures (from the input) from assumptions or interpretations.",
].join("\n");
