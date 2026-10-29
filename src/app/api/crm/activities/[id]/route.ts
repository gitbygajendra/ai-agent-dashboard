import { apiContext, json } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { deleteActivity, updateActivity } from "@/lib/crm";
import { handler } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  return json({ activity: await updateActivity(ctx, (await params).id, await readJson(req)) });
});

export const DELETE = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  await deleteActivity(ctx, (await params).id);
  return json({ ok: true });
});
