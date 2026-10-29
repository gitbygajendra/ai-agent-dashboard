import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeWorkflow, isConfigured, N8nError, webhookUrlFor, type N8nConfig } from "@/lib/n8n/client";
import type { WorkflowEnvelope } from "@/lib/agents/logic/n8n-entry";

const SLUG = "data-analytics-agent" as const;

const envelope: WorkflowEnvelope = {
  execution_id: "9b2f6c1e-1d1a-4c55-9a51-6c3f0f1f0a01",
  agent: SLUG,
  organization_id: "0c1d2e3f-0000-4000-8000-000000000001",
  callback: { url: "http://localhost:3000/api/n8n/callback/9b2f6c1e", token: "cb-token" },
  ai: { enabled: true, model: "claude-opus-5-5", provider: "anthropic" },
  input: { dataset: { name: "x.csv", columns: [], rows: [] } },
};

const config = (over: Partial<N8nConfig> = {}): N8nConfig => ({
  baseUrl: "http://n8n.internal:5678/",
  webhookSecret: "whsec-test",
  ackTimeoutMs: 1000,
  webhookUrls: {},
  ...over,
});

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function fetchReturning(...responses: (() => Response | Promise<Response>)[]) {
  let i = 0;
  return vi.fn(async (..._args: FetchArgs) => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  });
}

function connRefused(): never {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5678"), { code: "ECONNREFUSED" }) });
}

async function expectN8nError(p: Promise<unknown>, code: N8nError["code"]) {
  const err = await p.then(
    () => {
      throw new Error("expected invokeWorkflow to throw");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(N8nError);
  expect((err as N8nError).code).toBe(code);
  return err as N8nError;
}

beforeEach(() => {
  // The client logs through the JSON logger; keep test output clean.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhookUrlFor / isConfigured", () => {
  it("prefers the per-agent URL over the base URL", () => {
    const c = config({ webhookUrls: { [SLUG]: "https://hooks.example/custom-analytics" } });
    expect(webhookUrlFor(SLUG, c)).toBe("https://hooks.example/custom-analytics");
    expect(webhookUrlFor("finance-audit-agent", c)).toBe("http://n8n.internal:5678/webhook/finance-audit-agent");
  });

  it("builds the URL from the base URL (trailing slashes trimmed) or returns null", () => {
    expect(webhookUrlFor(SLUG, config({ baseUrl: "http://n8n///" }))).toBe("http://n8n/webhook/data-analytics-agent");
    expect(webhookUrlFor(SLUG, config({ baseUrl: undefined }))).toBeNull();
  });

  it("isConfigured needs both a URL and the secret", () => {
    expect(isConfigured(SLUG, config())).toBe(true);
    expect(isConfigured(SLUG, config({ webhookSecret: undefined }))).toBe(false);
    expect(isConfigured(SLUG, config({ baseUrl: undefined }))).toBe(false);
  });
});

describe("invokeWorkflow", () => {
  it("throws N8N_NOT_CONFIGURED without a URL or secret, without calling fetch", async () => {
    const f = fetchReturning(() => new Response(null, { status: 202 }));
    const e1 = await expectN8nError(invokeWorkflow(SLUG, envelope, config({ webhookSecret: undefined }), { fetchImpl: f, backoffMs: 1 }), "N8N_NOT_CONFIGURED");
    expect(e1.retryable).toBe(false);
    await expectN8nError(invokeWorkflow(SLUG, envelope, config({ baseUrl: undefined }), { fetchImpl: f, backoffMs: 1 }), "N8N_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("202 ack → accepted", async () => {
    const f = fetchReturning(() => new Response(JSON.stringify({ executionId: "n8n-77" }), { status: 202 }));
    await expect(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 })).resolves.toEqual({ kind: "accepted", n8nExecutionId: "n8n-77" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("202 with an empty or non-JSON body → accepted", async () => {
    const f = fetchReturning(() => new Response("Workflow was started", { status: 200 }));
    await expect(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 })).resolves.toEqual({ kind: "accepted", n8nExecutionId: null });
  });

  it("inline {status: succeeded, result} → completed", async () => {
    const f = fetchReturning(() => new Response(JSON.stringify({ status: "succeeded", result: { total: 42 }, n8n_execution_id: "n8n-1" }), { status: 200 }));
    await expect(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 })).resolves.toEqual({
      kind: "completed",
      status: "succeeded",
      result: { total: 42 },
      error: null,
      n8nExecutionId: "n8n-1",
    });
  });

  it("inline {status: failed, error} → completed with the error", async () => {
    const f = fetchReturning(() => new Response(JSON.stringify({ status: "failed", error: { code: "EMPTY_DATASET", message: "No rows" } }), { status: 200 }));
    await expect(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 })).resolves.toMatchObject({
      kind: "completed",
      status: "failed",
      result: null,
      error: { code: "EMPTY_DATASET", message: "No rows" },
    });
  });

  it("401 → N8N_AUTH_FAILED (not retried)", async () => {
    const f = fetchReturning(() => new Response("Authorization data is wrong!", { status: 401 }));
    const e = await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_AUTH_FAILED");
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("404 → N8N_WORKFLOW_NOT_FOUND", async () => {
    const f = fetchReturning(() => new Response("not registered", { status: 404 }));
    const e = await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_WORKFLOW_NOT_FOUND");
    expect(e.retryable).toBe(false);
  });

  it("422 → N8N_BAD_REQUEST", async () => {
    const f = fetchReturning(() => new Response("", { status: 422 }));
    await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_BAD_REQUEST");
  });

  it("500 → N8N_UPSTREAM_ERROR, retryable, not retried by the client", async () => {
    const f = fetchReturning(() => new Response("boom", { status: 500 }));
    const e = await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_UPSTREAM_ERROR");
    expect(e.retryable).toBe(true);
    expect(e.httpStatus).toBe(500);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("ECONNREFUSED twice then success → accepted after 3 calls", async () => {
    const f = fetchReturning(connRefused, connRefused, () => new Response(null, { status: 202 }));
    await expect(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 })).resolves.toEqual({ kind: "accepted", n8nExecutionId: null });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("ECONNREFUSED always → N8N_UNREACHABLE after maxConnectRetries + 1 calls", async () => {
    const f = fetchReturning(connRefused);
    const e = await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_UNREACHABLE");
    expect(e.retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(3); // default maxConnectRetries = 2

    const g = fetchReturning(connRefused);
    await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: g, backoffMs: 1, maxConnectRetries: 4 }), "N8N_UNREACHABLE");
    expect(g).toHaveBeenCalledTimes(5);
  });

  it("does not retry errors that are not connection failures", async () => {
    const f = fetchReturning(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    });
    await expectN8nError(invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 }), "N8N_UNREACHABLE");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("timeout → N8N_TIMEOUT and NOT retried", async () => {
    const f = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const e = await expectN8nError(invokeWorkflow(SLUG, envelope, config({ ackTimeoutMs: 15 }), { fetchImpl: f, backoffMs: 1 }), "N8N_TIMEOUT");
    expect(e.retryable).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sends the secret, idempotency key = execution_id and the JSON envelope", async () => {
    const f = fetchReturning(() => new Response(null, { status: 202 }));
    await invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://n8n.internal:5678/webhook/data-analytics-agent");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-webhook-secret"]).toBe("whsec-test");
    expect(headers["idempotency-key"]).toBe(envelope.execution_id);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(envelope);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the per-agent webhook URL when set", async () => {
    const f = fetchReturning(() => new Response(null, { status: 202 }));
    await invokeWorkflow(SLUG, envelope, config({ webhookUrls: { [SLUG]: "https://hooks.example/a" } }), { fetchImpl: f, backoffMs: 1 });
    expect(f.mock.calls[0][0]).toBe("https://hooks.example/a");
  });

  it("never logs the webhook secret or callback token", async () => {
    const f = fetchReturning(connRefused, () => new Response(null, { status: 202 }));
    await invokeWorkflow(SLUG, envelope, config(), { fetchImpl: f, backoffMs: 1 });
    const logged = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join("\n");
    expect(logged).not.toContain("whsec-test");
    expect(logged).not.toContain("cb-token");
  });
});

describe("master workflow mode", () => {
  it("routes every agent to the single master webhook", () => {
    const c = config({ mode: "master", baseUrl: "http://n8n.internal:5678/" });
    expect(webhookUrlFor("data-analytics-agent", c)).toBe("http://n8n.internal:5678/webhook/agent-dashboard");
    expect(webhookUrlFor("lead-generation-agent", c)).toBe("http://n8n.internal:5678/webhook/agent-dashboard");
  });

  it("prefers an explicit master URL, and a per-agent override over both", () => {
    const c = config({
      mode: "master",
      masterWebhookUrl: "https://hooks.example/master",
      webhookUrls: { "finance-audit-agent": "https://hooks.example/finance" },
    });
    expect(webhookUrlFor("data-analytics-agent", c)).toBe("https://hooks.example/master");
    expect(webhookUrlFor("finance-audit-agent", c)).toBe("https://hooks.example/finance");
  });

  it("sends the agent slug in the envelope so the master can route it", async () => {
    let sent: { agent?: string } = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    await invokeWorkflow("customer-support-agent", { ...envelope, agent: "customer-support-agent" }, config({ mode: "master" }), { fetchImpl });
    expect(sent.agent).toBe("customer-support-agent");
  });
});
