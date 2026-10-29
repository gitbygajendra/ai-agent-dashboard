import "server-only";
import type { OrgContext } from "../../auth/context";
import { assertCanWrite } from "../../auth/context";
import { env } from "../../env";
import { AppError, Errors } from "../../errors";
import { detectTabularFile, parseTabular, type Table } from "../../files/tabular";
import { getObject, objectKey, putObject } from "../../storage";

export type StoredTableRef = { path: string; file_name: string; kind: "csv" | "xlsx"; size: number };

export async function readForm(req: Request): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) throw Errors.invalid("Expected a file upload (multipart/form-data).");
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > env().MAX_UPLOAD_BYTES * 2 + 100_000) {
    throw new AppError("FILE_TOO_LARGE", "The upload is too large.", 413);
  }
  try {
    return await req.formData();
  } catch {
    throw Errors.invalid("Could not read the upload.");
  }
}

export async function readJson(req: Request, maxBytes = 200_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "The request is too large.", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Errors.invalid("Request body must be valid JSON.");
  }
}

/** Validate, parse and privately store an uploaded table. */
export async function acceptTableUpload(
  ctx: OrgContext,
  form: FormData,
  field: string,
  folder: string,
  required: boolean,
): Promise<{ table: Table; ref: StoredTableRef } | null> {
  assertCanWrite(ctx);
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) {
    if (required) throw Errors.invalid(`Please choose a file for "${field}".`);
    return null;
  }
  const e = env();
  const data = Buffer.from(await file.arrayBuffer());
  const kind = detectTabularFile(file.name, file.type, data, e.MAX_UPLOAD_BYTES);
  const table = await parseTabular(file.name, kind, data, e.MAX_DATASET_ROWS);
  const stored = await putObject(
    objectKey(ctx.orgId, folder, file.name),
    data,
    kind === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  return { table, ref: { path: stored.path, file_name: file.name.slice(0, 200), kind, size: stored.size } };
}

export async function loadStoredTable(ctx: OrgContext, ref: StoredTableRef | undefined | null): Promise<Table | null> {
  if (!ref?.path) return null;
  const data = await getObject(ref.path, ctx.orgId);
  return parseTabular(ref.file_name, ref.kind, data, env().MAX_DATASET_ROWS);
}

export function text(form: FormData, field: string, max = 2000): string | null {
  const v = form.get(field);
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > max) throw Errors.invalid(`"${field}" is too long (max ${max} characters).`);
  return t || null;
}

export function tableSummary(table: Table) {
  return { file_name: table.name, row_count: table.rows.length, column_count: table.columns.length, columns: table.columns.slice(0, 30) };
}
