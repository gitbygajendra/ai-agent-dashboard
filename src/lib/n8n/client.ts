import "server-only";
import type { AgentSlug } from "../agents/registry";
import { AGENTS } from "../agents/registry";
import type { WorkflowEnvelope } from "../agents/logic/n8n-entry";
import { logger } from "../logger";

/**
 * Server-side client for n8n webhooks.
 *
 * - The webhook secret is sent in a header that n8n's Header Auth credential checks.
 * - Each call carries an Idempotency-Key (the execution id) so a workflow can
 *   de-duplicate, and the client only retries when the request provably never
 *   reached n8n (connection refused / DNS failure). Timeouts are NOT retried:
 *   the workflow may already be running.
 * - Responses are normalized: a workflow either acknowledges (async; the result
 *   arrives later on the callback URL) or returns a completed result inline.
 */
export const MASTER_WEBHOOK_PATH = "agent-dashboard";

export type N8nConfig = {
  baseUrl?: string;
  /** "master" routes every agent through one workflow; defaults to per-agent when omitted. */
  mode?: "master" | "per-agent";
  masterWebhookUrl?: string;
  webhookSecret?: string;
  ackTimeoutMs: number;
  webhookUrls: Partial<Record<AgentSlug, string>>;
};

export type InvokeOutcome =
  | { kind: "accepted"; n8nExecutionId: string | null }
  | { kind: "completed"; status: "succeeded" | "failed"; result: unknown; error: { code: string; message: string } | null; n8nExecutionId: string | null };

export class N8nError extends Error {
  constructor(
    public readonly code:
      | "N8N_NOT_CONFIGURED"
      | "N8N_UNREACHABLE"
      | "N8N_TIMEOUT"
      | "N8N_AUTH_FAILED"
      | "N8N_WORKFLOW_NOT_FOUND"
      | "N8N_BAD_REQUEST"
      | "N8N_UPSTREAM_ERROR"
      | "N8N_INVALID_RESPONSE",
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "N8nError";
  }
}

export function webhookUrlFor(slug: AgentSlug, config: N8nConfig): string | null {
  const explicit = config.webhookUrls[slug];
  if (explicit) return explicit;
  if (config.mode === "master" && config.masterWebhookUrl) return config.masterWebhookUrl;
  if (!config.baseUrl) return null;
  const base = config.baseUrl.replace(/\/+$/, "");
  return config.mode === "master" ? `${base}/webhook/${MASTER_WEBHOOK_PATH}` : `${base}/webhook/${slug}`;
}

export function isConfigured(slug: AgentSlug, config: N8nConfig): boolean {
  return Boolean(webhookUrlFor(slug, config) && config.webhookSecret);
}

const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE_SEND"]);

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function invokeWorkflow(
  slug: AgentSlug,
  envelope: WorkflowEnvelope,
  config: N8nConfig,
  opts: { fetchImpl?: typeof fetch; maxConnectRetries?: number; backoffMs?: number } = {},
): Promise<InvokeOutcome> {
  const url = webhookUrlFor(slug, config);
  if (!url || !config.webhookSecret) {
    throw new N8nError(
      "N8N_NOT_CONFIGURED",
      `${AGENTS[slug].name} is not connected to n8n yet. Set N8N_BASE_URL and N8N_WEBHOOK_SECRET.`,
      false,
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxConnectRetries ?? 2;
  const backoff = opts.backoffMs ?? 500;
  const body = JSON.stringify(envelope);

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ackTimeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": config.webhookSecret,
          "idempotency-key": envelope.execution_id,
          "x-execution-id": envelope.execution_id,
        },
        body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        logger.warn("n8n_invoke_timeout", { slug, execution_id: envelope.execution_id, ms: Date.now() - started });
        throw new N8nError("N8N_TIMEOUT", "n8n did not acknowledge the request in time. The run may still complete; check Workflow Runs before retrying.", false);
      }
      const code = errorCode(err);
      if (code && CONNECT_ERRORS.has(code) && attempt < maxRetries) {
        logger.warn("n8n_invoke_connect_retry", { slug, attempt, code });
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      throw new N8nError("N8N_UNREACHABLE", "Could not reach n8n. Check that the n8n instance is running and N8N_BASE_URL is correct.", true);
    }
    clearTimeout(timer);
    logger.info("n8n_invoke_response", { slug, execution_id: envelope.execution_id, status: res.status, ms: Date.now() - started });
    return normalizeResponse(res);
  }
}

async function normalizeResponse(res: Response): Promise<InvokeOutcome> {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    throw new N8nError("N8N_AUTH_FAILED", "n8n rejected the webhook secret. Make sure N8N_WEBHOOK_SECRET matches the workflow's Header Auth credential.", false, res.status);
  }
  if (res.status === 404) {
    throw new N8nError("N8N_WORKFLOW_NOT_FOUND", "The n8n workflow was not found. Import n8n/agent-dashboard-master.json and make sure it is published/active.", false, res.status);
  }
  if (res.status >= 400 && res.status < 500) {
    throw new N8nError("N8N_BAD_REQUEST", `n8n rejected the request (HTTP ${res.status}).`, false, res.status);
  }
  if (res.status >= 500) {
    throw new N8nError("N8N_UPSTREAM_ERROR", `n8n returned an error (HTTP ${res.status}).`, true, res.status);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const n8nExecutionId = typeof d.n8n_execution_id === "string" ? d.n8n_execution_id : typeof d.executionId === "string" ? d.executionId : null;
  if (d.status === "succeeded" || d.status === "failed") {
    const err = d.error as { code?: unknown; message?: unknown } | null | undefined;
    return {
      kind: "completed",
      status: d.status,
      result: d.result ?? null,
      error: err && typeof err.message === "string" ? { code: String(err.code ?? "WORKFLOW_ERROR"), message: err.message } : null,
      n8nExecutionId,
    };
  }
  return { kind: "accepted", n8nExecutionId };
}

/** Checks that n8n is up (GET /healthz) without exposing secrets. */
export async function checkN8nHealth(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  if (!baseUrl) return { ok: false, message: "N8N_BASE_URL is not set." };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    return res.ok ? { ok: true, message: "n8n is reachable." } : { ok: false, message: `n8n health check returned HTTP ${res.status}.` };
  } catch {
    return { ok: false, message: "Could not reach n8n at N8N_BASE_URL." };
  }
}
