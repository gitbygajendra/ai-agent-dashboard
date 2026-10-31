import { WORKFLOW_LOGIC } from "./logic";
import type { CallbackBody, WorkflowEnvelope } from "./logic/n8n-entry";

export type CallAi = (url: string, headers: Record<string, string>, body: unknown) => Promise<unknown>;

/**
 * The built-in engine: runs an agent's pipeline in this process, exactly as
 * the n8n workflow does (validate → each stage → build AI prompt → optional AI
 * call → finalize), and returns the body n8n would post to the callback.
 */
export async function runPipeline(envelope: WorkflowEnvelope, callAi: CallAi): Promise<CallbackBody> {
  const entry = Object.keys(WORKFLOW_LOGIC).includes(envelope.agent) ? WORKFLOW_LOGIC[envelope.agent as keyof typeof WORKFLOW_LOGIC] : null;
  if (!entry) return { status: "failed", result: null, error: { code: "UNKNOWN_AGENT", message: `No agent named ${JSON.stringify(envelope.agent)}.` }, ai_status: "skipped" };
  const processed = entry.process(envelope);
  let aiResponse: unknown = null;
  if (processed.use_ai && processed.ai_url) {
    // A failed or refused AI call is not a failed run: finalize keeps the computed text.
    aiResponse = await callAi(processed.ai_url, processed.ai_headers ?? {}, processed.ai_body).catch(() => null);
  }
  return entry.finalize(processed, aiResponse);
}
