import { apiContext, json } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { createActivity } from "@/lib/crm";
import { handler } from "@/lib/errors";

export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  return json({ activity: await createActivity(ctx, await readJson(req)) }, { status: 201 });
});
