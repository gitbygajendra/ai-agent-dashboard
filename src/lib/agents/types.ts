import type { OrgContext } from "../auth/context";
import type { Tx } from "../db";
import type { AgentSlug } from "./registry";

export type ExecutionStatus = "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type ExecutionRow = {
  id: string;
  organization_id: string;
  agent_slug: AgentSlug;
  user_id: string | null;
  status: ExecutionStatus;
  trigger: "manual" | "retry" | "crm_event" | "approval" | "system";
  idempotency_key: string | null;
  retry_of: string | null;
  parent_execution_id: string | null;
  input_summary: Record<string, unknown>;
  input_ref: Record<string, unknown>;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  n8n_execution_id: string | null;
  ai_status: "used" | "skipped" | "unavailable" | null;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

/** Columns readable by clients (excludes callback_token_hash). */
export const EXECUTION_COLUMNS = `id, organization_id, agent_slug, user_id, status, trigger, idempotency_key, retry_of,
  parent_execution_id, input_summary, input_ref, result, error_code, error_message, n8n_execution_id, ai_status,
  attempt, started_at, completed_at, duration_ms, created_at, updated_at`;

export const FINAL_STATUSES: ExecutionStatus[] = ["succeeded", "failed", "timed_out", "cancelled"];

export type PreparedRun = {
  input: unknown;
  inputSummary: Record<string, unknown>;
  inputRef: Record<string, unknown>;
};

export type CompletionOutcome = { status?: "awaiting_approval"; result?: unknown };

export type AgentHandler = {
  /** Validate a manual run request and build the workflow input. */
  prepare?: (ctx: OrgContext, req: Request) => Promise<PreparedRun>;
  /** Rebuild the workflow input for a retry from the stored input reference. */
  rebuild: (ctx: OrgContext, execution: ExecutionRow) => Promise<unknown>;
  /** Apply the result to business records, inside the completion transaction (service role). */
  onComplete?: (tx: Tx, execution: ExecutionRow, result: unknown) => Promise<CompletionOutcome>;
  /** Side effects that must happen after commit (e.g. sending pre-approved emails). */
  afterCommit?: (execution: ExecutionRow) => Promise<void>;
};

export type HandlerMap = Record<AgentSlug, AgentHandler>;

export type { OrgContext };
