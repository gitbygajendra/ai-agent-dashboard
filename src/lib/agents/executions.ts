import "server-only";
import { z } from "zod";
import { audit } from "../audit";
import type { OrgContext } from "../auth/context";
import { randomToken, safeEqual, sha256Hex } from "../crypto";
import { withService, withUser } from "../db";
import { env } from "../env";
import { AppError, Errors } from "../errors";
import { logger } from "../logger";
import { invokeWorkflow, N8nError, type N8nConfig } from "../n8n/client";
import type { AgentSlug } from "./registry";
import { AGENTS } from "./registry";
import { EXECUTION_COLUMNS, FINAL_STATUSES, type ExecutionRow, type HandlerMap, type PreparedRun } from "./types";

export function n8nConfig(): N8nConfig {
  const e = env();
  return {
    baseUrl: e.N8N_BASE_URL,
    mode: e.N8N_WORKFLOW_MODE,
    masterWebhookUrl: e.N8N_MASTER_WEBHOOK_URL,
    webhookSecret: e.N8N_WEBHOOK_SECRET,
    ackTimeoutMs: e.N8N_ACK_TIMEOUT_MS,
    webhookUrls: {
      "data-analytics-agent": e.N8N_WEBHOOK_URL_DATA_ANALYTICS,
      "email-automation-agent": e.N8N_WEBHOOK_URL_EMAIL_AUTOMATION,
      "finance-audit-agent": e.N8N_WEBHOOK_URL_FINANCE_AUDIT,
      "crm-automation-agent": e.N8N_WEBHOOK_URL_CRM_AUTOMATION,
      "data-advisory-agent": e.N8N_WEBHOOK_URL_DATA_ADVISORY,
      "customer-support-agent": e.N8N_WEBHOOK_URL_CUSTOMER_SUPPORT,
      "lead-generation-agent": e.N8N_WEBHOOK_URL_LEAD_GENERATION,
    },
  };
}

let handlersPromise: Promise<HandlerMap> | null = null;
function handlers(): Promise<HandlerMap> {
  // Lazy import breaks the cycle handlers → executions (CRM events start runs).
  handlersPromise ??= import("./handlers").then((m) => m.HANDLERS);
  return handlersPromise;
}

type StartOptions = PreparedRun & {
  idempotencyKey?: string | null;
  trigger?: ExecutionRow["trigger"];
  retryOf?: string | null;
  parentExecutionId?: string | null;
  attempt?: number;
};

const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/);

export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get("idempotency-key");
  if (!raw) return null;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw Errors.invalid("Idempotency-Key header is malformed.");
  return parsed.data;
}

async function enforceRunRateLimit(ctx: OrgContext) {
  const limit = env().AGENT_RUNS_PER_MINUTE;
  const row = await withUser(ctx.user.id, (tx) =>
    tx.one<{ n: number }>(
      `select count(*)::int as n from public.agent_executions
        where organization_id = $1 and user_id = auth.uid() and trigger in ('manual', 'retry')
          and created_at > now() - interval '60 seconds'`,
      [ctx.orgId],
    ),
  );
  if ((row?.n ?? 0) >= limit) throw Errors.rateLimited(60);
}

/**
 * Create an execution record and hand the work to n8n.
 * Returns the execution as stored after the n8n call (running, or final if
 * n8n answered inline, or failed with a normalized error).
 */
export async function startExecution(
  ctx: OrgContext,
  slug: AgentSlug,
  opts: StartOptions,
): Promise<{ execution: ExecutionRow; duplicate: boolean }> {
  const trigger = opts.trigger ?? "manual";
  if (trigger === "manual" || trigger === "retry") await enforceRunRateLimit(ctx);

  const inserted = await withUser(ctx.user.id, async (tx) => {
    const agent = await tx.one<{ enabled: boolean }>(
      "select enabled from public.agents where organization_id = $1 and slug = $2",
      [ctx.orgId, slug],
    );
    if (!agent) throw Errors.notFound("Agent");
    if (!agent.enabled) throw new AppError("AGENT_DISABLED", `${AGENTS[slug].name} is turned off in Settings.`, 409);
    const row = await tx.one<ExecutionRow>(
      `insert into public.agent_executions
         (organization_id, agent_slug, user_id, status, trigger, idempotency_key, retry_of, parent_execution_id,
          input_summary, input_ref, attempt)
       values ($1, $2, auth.uid(), 'queued', $3, $4, $5, $6, $7, $8, $9)
       on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
       returning ${EXECUTION_COLUMNS}`,
      [
        ctx.orgId,
        slug,
        trigger,
        opts.idempotencyKey ?? null,
        opts.retryOf ?? null,
        opts.parentExecutionId ?? null,
        JSON.stringify(opts.inputSummary),
        JSON.stringify(opts.inputRef),
        opts.attempt ?? 1,
      ],
    );
    if (row) return { row, duplicate: false };
    const existing = await tx.one<ExecutionRow>(
      `select ${EXECUTION_COLUMNS} from public.agent_executions where organization_id = $1 and idempotency_key = $2`,
      [ctx.orgId, opts.idempotencyKey],
    );
    if (!existing) throw Errors.conflict("Duplicate request.");
    return { row: existing, duplicate: true };
  });
  if (inserted.duplicate) return { execution: inserted.row, duplicate: true };

  const execution = inserted.row;
  const token = randomToken(32);
  const e = env();
  await withService((tx) =>
    tx.query(
      `update public.agent_executions
          set status = 'running', started_at = now(), callback_token_hash = $2
        where id = $1 and status = 'queued'`,
      [execution.id, sha256Hex(token)],
    ),
  );
  await audit({
    orgId: ctx.orgId,
    actorId: ctx.user.id,
    action: "agent.run",
    entityType: "agent_execution",
    entityId: execution.id,
    metadata: { agent: slug, trigger, attempt: execution.attempt },
  });

  try {
    const outcome = await invokeWorkflow(
      slug,
      {
        execution_id: execution.id,
        agent: slug,
        organization_id: ctx.orgId,
        callback: { url: `${e.APP_BASE_URL.replace(/\/+$/, "")}/api/n8n/callback/${execution.id}`, token },
        ai: { enabled: e.AI_ENABLED === "true", model: e.AI_MODEL, provider: e.AI_PROVIDER },
        input: opts.input,
      },
      n8nConfig(),
    );
    if (outcome.kind === "completed") {
      await finalizeExecution(execution.id, {
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        n8nExecutionId: outcome.n8nExecutionId,
        aiStatus: null,
      });
    } else if (outcome.n8nExecutionId) {
      await withService((tx) =>
        tx.query("update public.agent_executions set n8n_execution_id = $2 where id = $1", [execution.id, outcome.n8nExecutionId]),
      );
    }
  } catch (err) {
    const n8nErr = err instanceof N8nError ? err : null;
    // A timeout means n8n may still be working: keep the run open and let the
    // callback (or the stale-run sweep) decide the final state.
    if (n8nErr?.code === "N8N_TIMEOUT") {
      logger.warn("execution_ack_timeout", { execution_id: execution.id });
    } else {
      await failExecution(execution.id, n8nErr?.code ?? "INVOKE_FAILED", n8nErr?.message ?? "Could not start the workflow.");
    }
  }
  return { execution: (await getExecutionForService(execution.id))!, duplicate: false };
}

async function getExecutionForService(id: string): Promise<ExecutionRow | null> {
  return withService((tx) => tx.one<ExecutionRow>(`select ${EXECUTION_COLUMNS} from public.agent_executions where id = $1`, [id]));
}

export async function failExecution(id: string, code: string, message: string) {
  await withService((tx) =>
    tx.query(
      `update public.agent_executions
          set status = 'failed', error_code = $2, error_message = $3, completed_at = now(),
              duration_ms = (extract(epoch from (now() - coalesce(started_at, created_at))) * 1000)::int
        where id = $1 and status in ('queued', 'running')`,
      [id, code, message.slice(0, 1000)],
    ),
  );
}

const callbackSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().max(100), message: z.string().max(2000) }).nullish(),
  ai_status: z.enum(["used", "skipped", "unavailable"]).nullish(),
  n8n_execution_id: z.union([z.string(), z.number()]).nullish(),
});

export type CallbackBody = z.infer<typeof callbackSchema>;

/**
 * Handle a completion callback from n8n. The bearer token is the single-use
 * secret generated for this execution; only its hash is stored.
 */
export async function handleCallback(executionId: string, bearer: string | null, rawBody: unknown) {
  if (!z.uuid().safeParse(executionId).success) throw Errors.notFound("Execution");
  if (!bearer) throw Errors.unauthorized();
  const row = await withService((tx) =>
    tx.one<{ status: string; callback_token_hash: string | null }>(
      "select status, callback_token_hash from public.agent_executions where id = $1",
      [executionId],
    ),
  );
  if (!row || !row.callback_token_hash || !safeEqual(sha256Hex(bearer), row.callback_token_hash)) {
    throw Errors.unauthorized();
  }
  if (FINAL_STATUSES.includes(row.status as ExecutionRow["status"]) || row.status === "awaiting_approval") {
    // Already recorded (e.g. n8n retried the callback). Acknowledge without changes.
    return { recorded: false, status: row.status };
  }
  const body = callbackSchema.parse(rawBody);
  const sizeOk = JSON.stringify(body.result ?? null).length <= 5_000_000;
  if (!sizeOk) {
    await failExecution(executionId, "RESULT_TOO_LARGE", "The workflow returned more data than can be stored.");
    return { recorded: true, status: "failed" };
  }
  const status = await finalizeExecution(executionId, {
    status: body.status,
    result: body.result ?? null,
    error: body.error ?? null,
    n8nExecutionId: body.n8n_execution_id != null ? String(body.n8n_execution_id) : null,
    aiStatus: body.ai_status ?? null,
  });
  return { recorded: true, status };
}

async function finalizeExecution(
  id: string,
  outcome: {
    status: "succeeded" | "failed";
    result: unknown;
    error: { code: string; message: string } | null;
    n8nExecutionId: string | null;
    aiStatus: ExecutionRow["ai_status"];
  },
): Promise<string> {
  const map = await handlers();
  let committed: ExecutionRow | null = null;
  await withService(async (tx) => {
    const execution = await tx.one<ExecutionRow>(
      `select ${EXECUTION_COLUMNS} from public.agent_executions where id = $1 for update`,
      [id],
    );
    if (!execution || !["queued", "running"].includes(execution.status)) return;
    let status: ExecutionRow["status"] = outcome.status;
    let result = outcome.result;
    let errorCode = outcome.status === "failed" ? outcome.error?.code ?? "WORKFLOW_FAILED" : null;
    let errorMessage = outcome.status === "failed" ? outcome.error?.message ?? "The workflow reported a failure." : null;
    if (outcome.status === "succeeded") {
      if (result === null || typeof result !== "object") {
        status = "failed";
        errorCode = "INVALID_RESULT";
        errorMessage = "The workflow returned an empty or malformed result.";
      } else {
        const handler = map[execution.agent_slug];
        try {
          const applied = handler?.onComplete ? await handler.onComplete(tx, execution, result) : {};
          if (applied.status) status = applied.status;
          if (applied.result !== undefined) result = applied.result;
        } catch (err) {
          logger.error("execution_on_complete_failed", { execution_id: id, error: (err as Error).message });
          status = "failed";
          errorCode = "APPLY_FAILED";
          errorMessage = err instanceof AppError ? err.message : "The result could not be applied to your records.";
        }
      }
    }
    committed = await tx.one<ExecutionRow>(
      `update public.agent_executions
          set status = $2, result = $3, error_code = $4, error_message = $5,
              n8n_execution_id = coalesce($6, n8n_execution_id), ai_status = $7,
              completed_at = case when $2 = 'awaiting_approval' then null else now() end,
              duration_ms = (extract(epoch from (now() - coalesce(started_at, created_at))) * 1000)::int
        where id = $1
        returning ${EXECUTION_COLUMNS}`,
      [id, status, result === null ? null : JSON.stringify(result), errorCode, errorMessage, outcome.n8nExecutionId, outcome.aiStatus],
    );
  });
  const done = committed as ExecutionRow | null;
  if (!done) return "unchanged";
  logger.info("execution_finalized", { execution_id: id, agent: done.agent_slug, status: done.status, ai_status: done.ai_status });
  const after = map[done.agent_slug]?.afterCommit;
  if (after && done.status !== "failed") {
    after(done).catch((err) => logger.error("execution_after_commit_failed", { execution_id: id, error: (err as Error).message }));
  }
  return done.status;
}

/** Mark runs that never called back as timed out. Called lazily on reads. */
export async function sweepStaleExecutions(orgId: string) {
  const timeoutMs = env().EXECUTION_TIMEOUT_MS;
  await withService((tx) =>
    tx.query(
      `update public.agent_executions
          set status = 'timed_out', completed_at = now(), error_code = 'TIMED_OUT',
              error_message = 'The workflow did not report back in time. Check the n8n execution log, then retry.',
              duration_ms = (extract(epoch from (now() - coalesce(started_at, created_at))) * 1000)::int
        where organization_id = $1 and status in ('queued', 'running')
          and coalesce(started_at, created_at) < now() - ($2::int * interval '1 millisecond')`,
      [orgId, timeoutMs],
    ),
  );
}

export async function getExecution(ctx: OrgContext, id: string): Promise<ExecutionRow> {
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Run");
  await sweepStaleExecutions(ctx.orgId);
  const row = await withUser(ctx.user.id, (tx) =>
    tx.one<ExecutionRow>(`select ${EXECUTION_COLUMNS} from public.agent_executions where id = $1 and organization_id = $2`, [id, ctx.orgId]),
  );
  if (!row) throw Errors.notFound("Run");
  return row;
}

export type ExecutionListFilter = { agent?: AgentSlug; status?: ExecutionRow["status"]; limit?: number; offset?: number };

export async function listExecutions(ctx: OrgContext, filter: ExecutionListFilter = {}) {
  await sweepStaleExecutions(ctx.orgId);
  const where = ["organization_id = $1"];
  const params: unknown[] = [ctx.orgId];
  if (filter.agent) {
    params.push(filter.agent);
    where.push(`agent_slug = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  params.push(limit, filter.offset ?? 0);
  // List view omits the (potentially large) result payload.
  return withUser(ctx.user.id, (tx) =>
    tx.query<Omit<ExecutionRow, "result">>(
      `select id, organization_id, agent_slug, user_id, status, trigger, retry_of, input_summary, error_code, error_message,
              n8n_execution_id, ai_status, attempt, started_at, completed_at, duration_ms, created_at, updated_at
         from public.agent_executions
        where ${where.join(" and ")}
        order by created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    ),
  );
}

export async function retryExecution(ctx: OrgContext, id: string, idempotencyKey: string | null) {
  const original = await getExecution(ctx, id);
  if (!["failed", "timed_out"].includes(original.status)) {
    throw Errors.conflict("Only failed or timed-out runs can be retried.");
  }
  const handler = (await handlers())[original.agent_slug];
  const input = await handler.rebuild(ctx, original);
  return startExecution(ctx, original.agent_slug, {
    input,
    inputSummary: original.input_summary,
    inputRef: original.input_ref,
    idempotencyKey: idempotencyKey ?? `retry:${original.id}:${original.attempt + 1}`,
    trigger: "retry",
    retryOf: original.id,
    parentExecutionId: original.parent_execution_id,
    attempt: original.attempt + 1,
  });
}

export async function runAgent(ctx: OrgContext, slug: AgentSlug, req: Request) {
  const handler = (await handlers())[slug];
  if (!handler.prepare || !AGENTS[slug].manualRun) {
    throw new AppError("NOT_MANUAL", `${AGENTS[slug].name} runs automatically from CRM events.`, 400);
  }
  const idempotencyKey = readIdempotencyKey(req);
  const prepared = await handler.prepare(ctx, req);
  return startExecution(ctx, slug, { ...prepared, idempotencyKey, trigger: "manual" });
}
