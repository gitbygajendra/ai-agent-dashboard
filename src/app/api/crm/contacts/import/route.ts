import { apiContext, json } from "@/lib/api";
import { assertCanWrite } from "@/lib/auth/context";
import { readForm } from "@/lib/agents/handlers/shared";
import { importContacts } from "@/lib/crm";
import { env } from "@/lib/env";
import { Errors, handler } from "@/lib/errors";
import { detectTabularFile, parseTabular } from "@/lib/files/tabular";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const form = await readForm(req);
  const file = form.get("file");
  if (!(file instanceof File)) throw Errors.invalid("Choose a CSV file to import.");
  const data = Buffer.from(await file.arrayBuffer());
  const kind = detectTabularFile(file.name, file.type, data, env().MAX_UPLOAD_BYTES);
  const table = await parseTabular(file.name, kind, data, 5000);
  return json(await importContacts(ctx, table));
});
