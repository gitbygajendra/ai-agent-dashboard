import { z } from "zod";
import { apiContext, json, searchParams } from "@/lib/api";
import { listOpenTasks } from "@/lib/crm";
import { handler } from "@/lib/errors";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

/** Open tasks and reminders across all contacts, soonest due first. */
export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const { limit } = querySchema.parse(searchParams(req));
  return json({ tasks: await listOpenTasks(ctx, limit) });
});
