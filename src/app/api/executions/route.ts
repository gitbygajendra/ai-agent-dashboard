import { z } from "zod";
import { apiContext, json, searchParams } from "@/lib/api";
import { listExecutions } from "@/lib/agents/executions";
import { AGENT_SLUGS } from "@/lib/agents/registry";
import { handler } from "@/lib/errors";

const filterSchema = z.object({
  agent: z.enum(AGENT_SLUGS).optional(),
  status: z.enum(["queued", "running", "awaiting_approval", "succeeded", "failed", "timed_out", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const filter = filterSchema.parse(searchParams(req));
  return json({ executions: await listExecutions(ctx, filter) });
});
