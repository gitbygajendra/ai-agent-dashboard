"use client";

import type { AgentSlug } from "@/lib/agents/registry";
import { newIdempotencyKey } from "@/lib/utils";
import type { ExecutionDetail } from "./types";

/**
 * Start an agent run. Pass FormData for file uploads or a plain object for JSON.
 * One idempotency key per submit protects against double-clicks and retries.
 */
export async function startRun(slug: AgentSlug, body: FormData | Record<string, unknown>): Promise<ExecutionDetail> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api/agents/${slug}/run`, {
    method: "POST",
    headers: { "idempotency-key": newIdempotencyKey(), ...(isForm ? {} : { "content-type": "application/json" }) },
    body: isForm ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Could not start the run (HTTP ${res.status}).`) as Error & { details?: unknown };
    err.details = data?.error?.details;
    throw err;
  }
  return data.execution as ExecutionDetail;
}
