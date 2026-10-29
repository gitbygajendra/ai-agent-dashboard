import { apiContext, json } from "@/lib/api";
import { getExecution } from "@/lib/agents/executions";
import { handler } from "@/lib/errors";

export const GET = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await apiContext(req);
  return json({ execution: await getExecution(ctx, id) });
});
