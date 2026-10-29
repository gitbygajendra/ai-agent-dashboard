import { json } from "@/lib/api";
import { handleCallback } from "@/lib/agents/executions";
import { AppError, handler } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Completion callback from n8n. Authenticated with the per-execution bearer
 * token the dashboard generated for this run (single use: once the run is
 * final, further callbacks change nothing).
 */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rl = rateLimit(`callback:${ip}`, 600, 60_000);
  if (!rl.ok) throw new AppError("RATE_LIMITED", "Too many callbacks.", 429);
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 6_000_000) throw new AppError("PAYLOAD_TOO_LARGE", "Callback payload too large.", 413);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("INVALID_JSON", "Callback body must be JSON.", 400);
  }
  return json(await handleCallback(id, bearer, body));
});
