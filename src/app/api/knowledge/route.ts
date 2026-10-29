import { z } from "zod";
import { apiContext, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { assertCanWrite } from "@/lib/auth/context";
import { readForm, text } from "@/lib/agents/handlers/shared";
import { withUser } from "@/lib/db";
import { AppError, Errors, handler } from "@/lib/errors";
import { chunkText } from "@/lib/knowledge";
import { objectKey, putObject } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_DOC_BYTES = 1024 * 1024;

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const documents = await withUser(ctx.user.id, (tx) =>
    tx.query(
      `select id, title, source_type, mime_type, size_bytes, status, chunk_count, approved, created_at
         from public.knowledge_documents where organization_id = $1 order by created_at desc`,
      [ctx.orgId],
    ),
  );
  return json({ documents });
});

/** Add a document from an uploaded .txt/.md file or pasted text. */
export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const form = await readForm(req);
  const file = form.get("file");
  let title = text(form, "title", 200);
  let content: string;
  let stored: { path: string; size: number } | null = null;
  let mime = "text/plain";
  if (file instanceof File && file.size > 0) {
    if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new AppError("INVALID_FILE_TYPE", "Upload a .txt or .md file, or paste the text.", 415);
    if (file.size > MAX_DOC_BYTES) throw new AppError("FILE_TOO_LARGE", "Documents must be under 1 MB.", 413);
    const data = Buffer.from(await file.arrayBuffer());
    if (data.subarray(0, 4096).includes(0)) throw new AppError("INVALID_FILE_TYPE", "That file isn't plain text.", 415);
    content = data.toString("utf8");
    mime = file.name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown";
    stored = await putObject(objectKey(ctx.orgId, "knowledge", file.name), data, mime);
    title ??= file.name.replace(/\.(txt|md|markdown)$/i, "");
  } else {
    content = text(form, "content", 200_000) ?? "";
  }
  const parsedTitle = z.string().trim().min(1, "Give the document a title.").max(200).parse(title ?? "");
  const chunks = chunkText(content);
  if (!chunks.length) throw Errors.invalid("The document is empty.");
  const doc = await withUser(ctx.user.id, async (tx) => {
    const d = await tx.one<{ id: string }>(
      `insert into public.knowledge_documents (organization_id, title, source_type, storage_path, mime_type, size_bytes, status, chunk_count, created_by)
       values ($1, $2, $3, $4, $5, $6, 'ready', $7, auth.uid()) returning id`,
      [ctx.orgId, parsedTitle, stored ? "upload" : "text", stored?.path ?? null, mime, stored?.size ?? Buffer.byteLength(content), chunks.length],
    );
    for (const [i, c] of chunks.entries()) {
      await tx.query("insert into public.knowledge_chunks (organization_id, document_id, chunk_index, content) values ($1, $2, $3, $4)", [ctx.orgId, d!.id, i, c]);
    }
    return d!;
  });
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "knowledge.added", entityType: "knowledge_document", entityId: doc.id, metadata: { chunks: chunks.length } });
  return json({ id: doc.id, chunks: chunks.length }, { status: 201 });
});
