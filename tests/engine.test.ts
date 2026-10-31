import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPipeline } from "@/lib/agents/engine";
import type { WorkflowEnvelope } from "@/lib/agents/logic/n8n-entry";

const csv = readFileSync(path.join(__dirname, "..", "public", "samples", "sample-sales.csv"), "utf8").trim().split(/\r?\n/);
const columns = csv[0].split(",");
const rows = csv.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [columns[i], v])));

const envelope = (over: Partial<WorkflowEnvelope> = {}): WorkflowEnvelope => ({
  execution_id: "11111111-1111-4111-8111-111111111111",
  agent: "data-analytics-agent",
  organization_id: "22222222-2222-4222-8222-222222222222",
  callback: { url: "http://localhost/cb", token: "t" },
  ai: { enabled: true, model: "llama-3.3-70b-versatile", provider: "groq" },
  input: { dataset: { name: "sample-sales.csv", columns, rows }, currency: "INR" },
  ...over,
});

describe("built-in engine", () => {
  it("runs the pipeline and merges the AI answer", async () => {
    let called: { url: string; headers: Record<string, string> } | null = null;
    const body = await runPipeline(envelope(), async (url, headers) => {
      called = { url, headers };
      return { choices: [{ message: { content: JSON.stringify({ summary: "AI summary.", insights: ["one"], answer: null }) }, finish_reason: "stop" }] };
    });
    expect(called!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(body).toMatchObject({ status: "succeeded", ai_status: "used", result: { summary: "AI summary.", ai_generated: true } });
  });

  it("keeps computed results when the AI call fails", async () => {
    const body = await runPipeline(envelope(), async () => {
      throw new Error("network down");
    });
    expect(body.status).toBe("succeeded");
    expect(body.ai_status).toBe("unavailable");
    expect((body.result as { summary: string }).summary).toMatch(/Revenue across/);
  });

  it("skips the AI call when AI is off, and fails cleanly on bad input or unknown agent", async () => {
    const noAi = vi_fn();
    expect(await runPipeline(envelope({ ai: { enabled: false, model: "", provider: "groq" } }), noAi.fn)).toMatchObject({ status: "succeeded", ai_status: "skipped" });
    expect(noAi.calls).toBe(0);
    expect(await runPipeline(envelope({ input: { dataset: { name: "x", columns: [], rows: [] } } }), noAi.fn)).toMatchObject({ status: "failed", error: { code: "EMPTY_DATASET" } });
    expect(await runPipeline(envelope({ agent: "nope" }), noAi.fn)).toMatchObject({ status: "failed", error: { code: "UNKNOWN_AGENT" } });
  });
});

function vi_fn() {
  const state = { calls: 0, fn: async () => { state.calls++; return null; } };
  return state;
}
