import Papa from "papaparse";
import ExcelJS from "exceljs";
import { AppError } from "../errors";

export type Table = { name: string; columns: string[]; rows: Record<string, unknown>[] };

// Browsers and OSes report CSV inconsistently; the content checks below are what matter.
const CSV_TYPES = new Set(["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream", ""]);
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type FileKind = "csv" | "xlsx";

/** Validate name, declared type, size and magic bytes. Returns the detected kind. */
export function detectTabularFile(name: string, type: string, data: Buffer, maxBytes: number): FileKind {
  if (data.length === 0) throw new AppError("EMPTY_FILE", "The file is empty.", 400);
  if (data.length > maxBytes) {
    throw new AppError("FILE_TOO_LARGE", `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413);
  }
  const lower = name.toLowerCase();
  const isZip = data[0] === 0x50 && data[1] === 0x4b; // "PK" — xlsx is a zip container
  if (lower.endsWith(".xlsx")) {
    if (!isZip || (type && type !== XLSX_TYPE && type !== "application/octet-stream")) {
      throw new AppError("INVALID_FILE_TYPE", "That doesn't look like a valid .xlsx file.", 415);
    }
    return "xlsx";
  }
  if (lower.endsWith(".csv")) {
    if (isZip || !CSV_TYPES.has(type)) throw new AppError("INVALID_FILE_TYPE", "That doesn't look like a valid CSV file.", 415);
    if (data.subarray(0, 4096).includes(0)) throw new AppError("INVALID_FILE_TYPE", "The CSV file contains binary data.", 415);
    return "csv";
  }
  throw new AppError("INVALID_FILE_TYPE", "Upload a .csv or .xlsx file.", 415);
}

function uniqueHeaders(raw: string[]): string[] {
  const base = raw.map((h, i) => (String(h ?? "").trim() || `column_${i + 1}`).slice(0, 96));
  const used = new Set<string>();
  // Reserve original names first so a renamed duplicate never takes an existing header.
  const firstIndex = new Map<string, number>();
  base.forEach((name, i) => {
    if (!firstIndex.has(name.toLowerCase())) firstIndex.set(name.toLowerCase(), i);
  });
  firstIndex.forEach((_, lower) => used.add(lower));
  return base.map((name, i) => {
    if (firstIndex.get(name.toLowerCase()) === i) return name;
    let n = 2;
    while (used.has(`${name}_${n}`.toLowerCase())) n++;
    const renamed = `${name}_${n}`;
    used.add(renamed.toLowerCase());
    return renamed;
  });
}

export async function parseTabular(name: string, kind: FileKind, data: Buffer, maxRows: number): Promise<Table> {
  const table = kind === "csv" ? parseCsv(name, data) : await parseXlsx(name, data);
  if (table.columns.length === 0) throw new AppError("NO_HEADERS", "The file needs a header row with column names.", 422);
  if (table.columns.length > 200) throw new AppError("TOO_MANY_COLUMNS", "The file has more than 200 columns.", 422);
  if (table.rows.length === 0) throw new AppError("EMPTY_DATASET", "The file has a header row but no data rows.", 422);
  if (table.rows.length > maxRows) {
    throw new AppError("TOO_MANY_ROWS", `The file has ${table.rows.length.toLocaleString()} rows; the limit is ${maxRows.toLocaleString()}.`, 422);
  }
  return table;
}

function parseCsv(name: string, data: Buffer): Table {
  let text = data.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  if (parsed.errors.some((e) => e.type === "Quotes")) {
    throw new AppError("CSV_PARSE_ERROR", `Could not read the CSV: ${parsed.errors[0].message} (row ${parsed.errors[0].row}).`, 422);
  }
  const [header, ...body] = parsed.data;
  if (!header) return { name, columns: [], rows: [] };
  const columns = uniqueHeaders(header);
  const rows = body.map((cells) => {
    const row: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = cells[i];
      row[c] = v === undefined ? null : sanitizeCell(v);
    });
    return row;
  });
  return { name, columns, rows };
}

/** Neutralize spreadsheet formula injection if the data is later exported. */
function sanitizeCell(v: string): string {
  const t = v.trim();
  return t.length > 2000 ? t.slice(0, 2000) : t;
}

async function parseXlsx(name: string, data: Buffer): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new AppError("XLSX_PARSE_ERROR", "Could not read the Excel file. Save it as .xlsx and try again.", 422);
  }
  const ws = wb.worksheets[0];
  if (!ws) return { name, columns: [], rows: [] };
  const headerRow = ws.getRow(1);
  const rawHeaders: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) rawHeaders.push(cellToValue(headerRow.getCell(c).value)?.toString() ?? "");
  while (rawHeaders.length && !rawHeaders[rawHeaders.length - 1]) rawHeaders.pop();
  const columns = uniqueHeaders(rawHeaders);
  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = cellToValue(row.getCell(i + 1).value);
    });
    rows.push(obj);
  }
  return { name, columns, rows };
}

function cellToValue(v: ExcelJS.CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return sanitizeCell(v);
  if (typeof v === "object") {
    if ("result" in v) return cellToValue((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ("error" in v) return null;
  }
  return String(v);
}

/** Escape a value for CSV export, guarding against formula injection (=, +, -, @). */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
