import { apiContext, json } from "@/lib/api";
import { runAgent } from "@/lib/agents/executions";
import { isAgentSlug } from "@/lib/agents/registry";
import { Errors, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = handler(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  if (!isAgentSlug(slug)) throw Errors.notFound("Agent");
  const ctx = await apiContext(req);
  const { execution, duplicate } = await runAgent(ctx, slug, req);
  return json({ execution, duplicate }, { status: duplicate ? 200 : 202 });
});
