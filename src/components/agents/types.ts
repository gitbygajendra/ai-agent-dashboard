import type { AgentSlug } from "@/lib/agents/registry";

/** Execution as returned by GET /api/executions/:id (client-safe columns). */
export type ExecutionDetail = {
  id: string;
  agent_slug: AgentSlug;
  status: "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "timed_out" | "cancelled";
  trigger: string;
  input_summary: Record<string, unknown>;
  input_ref: Record<string, unknown>;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  ai_status: "used" | "skipped" | "unavailable" | null;
  attempt: number;
  retry_of: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
};

/** Props every agent input panel receives from the workspace. */
export type InputPanelProps = {
  slug: AgentSlug;
  canWrite: boolean;
  currency: string;
  /** Non-null when the agent can't run right now (e.g. n8n not configured); show it and disable submit. */
  blockedReason: string | null;
  /** Call with the execution returned by POST /api/agents/:slug/run. The workspace then polls it. */
  onStarted: (execution: ExecutionDetail) => void;
  /** The currently selected execution, if any (e.g. for chat-style agents that continue a conversation). */
  current: ExecutionDetail | null;
};

/** Props every agent result view receives. Only rendered for executions with a result. */
export type ResultViewProps = {
  execution: ExecutionDetail;
  currency: string;
  canWrite: boolean;
  /** Call with the updated execution after an approval/rejection so the workspace refreshes. */
  onChange: (execution: ExecutionDetail) => void;
};
