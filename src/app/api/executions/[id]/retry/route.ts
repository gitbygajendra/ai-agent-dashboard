import { apiContext, json } from "@/lib/api";
import { assertCanWrite } from "@/lib/auth/context";
import { readIdempotencyKey, retryExecution } from "@/lib/agents/executions";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await apiContext(req);
  assertCanWrite(ctx);
  const { execution, duplicate } = await retryExecution(ctx, id, readIdempotencyKey(req));
  return json({ execution, duplicate }, { status: 202 });
});
