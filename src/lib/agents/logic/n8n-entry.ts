import type { AiRequest, LogicOutput, Stage } from "./common";

/**
 * The request envelope the dashboard sends to every n8n workflow, and the
 * three steps each workflow's Code nodes run. Bundled into the workflows by
 * scripts/build-n8n-workflows.ts.
 */
export type AiProvider = "anthropic" | "groq";

export type WorkflowEnvelope = {
  execution_id: string;
  agent: string;
  organization_id: string;
  callback: { url: string; token: string };
  ai: { enabled: boolean; model: string; provider: AiProvider };
  input: unknown;
};

export type Processed = {
  ok: boolean;
  execution_id: string | null;
  result: unknown;
  error: { code: string; message: string } | null;
  use_ai: boolean;
  ai_url: string | null;
  ai_body: Record<string, unknown> | null;
  ai_headers: Record<string, string> | null;
};

export type CallbackBody = {
  status: "succeeded" | "failed";
  result: unknown;
  error: { code: string; message: string } | null;
  ai_status: "used" | "skipped" | "unavailable";
};

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

const JSON_HEADERS = { "content-type": "application/json" };

/** OpenAI-compatible chat completions (Groq). Auth: n8n Header Auth credential `Authorization: Bearer <key>`. */
export function buildGroqRequest(ai: AiRequest, model: string) {
  const body: Record<string, unknown> = {
    model,
    max_tokens: ai.max_tokens,
    messages: [
      { role: "system", content: ai.system },
      { role: "user", content: ai.prompt },
    ],
  };
  return { url: "https://api.groq.com/openai/v1/chat/completions", body, headers: { ...JSON_HEADERS } };
}

export function buildAiRequest(provider: AiProvider, ai: AiRequest, model: string) {
  return provider === "groq" ? buildGroqRequest(ai, model) : buildClaudeRequest(ai, model);
}

/** Anthropic Messages API. Auth: n8n Header Auth credential `x-api-key`. */
export function buildClaudeRequest(ai: AiRequest, model: string) {
  const useFallbacks = FALLBACK_MODELS.has(model);
  const body: Record<string, unknown> = {
    model,
    max_tokens: ai.max_tokens,
    system: ai.system,
    messages: [{ role: "user", content: ai.prompt }],
  };
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...JSON_HEADERS };
  if (useFallbacks) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return { url: "https://api.anthropic.com/v1/messages", body, headers };
}

/** A stage that already failed carries the final failure forward unchanged. */
export type Failed = Processed & { ok: false };
export type Validated = { ok: true; execution_id: string } | Failed;
export type Computed = { ok: true; execution_id: string; result: unknown; ai_request: AiRequest | null } | Failed;

function failed(executionId: string | null, error: { code: string; message: string }): Failed {
  return { ok: false, execution_id: executionId, result: null, error, use_ai: false, ai_url: null, ai_body: null, ai_headers: null };
}

/**
 * Three stages so the n8n canvas can show them as separate nodes:
 * validate (envelope) → compute (agent logic) → plan (AI request). `process`
 * runs all three; `finalize` merges the AI answer back in.
 */
export type StageItem = { ok: true; execution_id: string; state: unknown } | Failed;

type PipelineState<I, R> = { input: I; output?: LogicOutput<R> };

export function makeN8nEntry<I, R>(
  logic: Stage<PipelineState<I, R>>[] | ((input: I) => LogicOutput<R>),
  merge: (result: R, aiResponse: unknown) => R,
) {
  // A plain function is a one-stage pipeline.
  const stages: Stage<PipelineState<I, R>>[] = typeof logic === "function" ? [{ name: "compute results", run: (s) => ({ ...s, output: logic(s.input) }) }] : logic;
  const entry = {
    stageNames: stages.map((s) => s.name),

    /** Runs stage `i` on the state carried by the previous node's item. The last stage yields the Computed item. */
    stage(i: number, prev: Validated | StageItem | Computed, envelope: WorkflowEnvelope): StageItem | Computed {
      if (!prev.ok) return prev;
      if ("result" in prev) return prev; // finished early in an earlier stage
      const state = ("state" in prev ? prev.state : { input: envelope.input }) as PipelineState<I, R>;
      let next: PipelineState<I, R>;
      try {
        next = stages[i].run(state);
      } catch (err) {
        return failed(prev.execution_id, { code: "PROCESSING_ERROR", message: `Processing failed: ${(err as Error).message}`.slice(0, 500) });
      }
      if (next.output && !next.output.ok) return failed(prev.execution_id, next.output.error);
      // An early output (e.g. an escalation) is final; remaining stages pass it through.
      if (next.output) return { ok: true, execution_id: prev.execution_id, result: next.output.result, ai_request: next.output.ai_request };
      if (i < stages.length - 1) return { ok: true, execution_id: prev.execution_id, state: next };
      return failed(prev.execution_id, { code: "PROCESSING_ERROR", message: "The pipeline produced no output." });
    },

    validate(envelope: WorkflowEnvelope): Validated {
      const executionId = typeof envelope?.execution_id === "string" ? envelope.execution_id : null;
      if (!executionId || !envelope.callback?.url || !envelope.callback?.token) {
        return failed(executionId, { code: "BAD_ENVELOPE", message: "Request is missing execution_id or callback details." });
      }
      return { ok: true, execution_id: executionId };
    },

    compute(prev: Validated, envelope: WorkflowEnvelope): Computed {
      let item: Validated | StageItem | Computed = prev;
      for (let i = 0; i < stages.length; i++) item = entry.stage(i, item, envelope);
      return item as Computed;
    },

    plan(prev: Computed, envelope: WorkflowEnvelope): Processed {
      if (!prev.ok) return prev;
      const useAi = Boolean(envelope.ai?.enabled && prev.ai_request);
      const provider: AiProvider = envelope.ai?.provider === "groq" ? "groq" : "anthropic";
      const req = useAi && prev.ai_request ? buildAiRequest(provider, prev.ai_request, envelope.ai.model || (provider === "groq" ? "llama-3.3-70b-versatile" : "claude-opus-5-5")) : null;
      return { ok: true, execution_id: prev.execution_id, result: prev.result, error: null, use_ai: useAi, ai_url: req?.url ?? null, ai_body: req?.body ?? null, ai_headers: req?.headers ?? null };
    },

    process(envelope: WorkflowEnvelope): Processed {
      return entry.plan(entry.compute(entry.validate(envelope), envelope), envelope);
    },

    finalize(processed: Processed, aiResponse: unknown): CallbackBody {
      if (!processed.ok) return { status: "failed", result: null, error: processed.error, ai_status: "skipped" };
      if (!processed.use_ai) return { status: "succeeded", result: processed.result, error: null, ai_status: "skipped" };
      try {
        const merged = merge(processed.result as R, aiResponse) as R & { ai_generated?: boolean };
        return { status: "succeeded", result: merged, error: null, ai_status: merged.ai_generated ? "used" : "unavailable" };
      } catch {
        return { status: "succeeded", result: processed.result, error: null, ai_status: "unavailable" };
      }
    },
  };
  return entry;
}
