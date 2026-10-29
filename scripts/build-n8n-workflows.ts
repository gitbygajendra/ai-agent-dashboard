/**
 * Generates importable n8n workflow JSON.
 *
 *   npm run n8n:build               → n8n/agent-dashboard-master.json (one workflow, all 7 agents)
 *   npm run n8n:build -- --per-agent → n8n/workflows/<agent>.json (one workflow per agent)
 *   npm run n8n:build -- --ai-credential → AI node authenticates with the "AI API Key" Header Auth
 *                                       credential instead of GROQ_API_KEY / ANTHROPIC_API_KEY env vars
 *
 * The workflows embed the agent logic from src/lib/agents/logic, bundled with
 * esbuild into the Code nodes, so the code that runs in n8n is the same code
 * the unit tests cover. Re-run after changing any logic module, then re-import.
 *
 * Workflow shape (master; per-agent files have one "Validate and process" node
 * instead of the Switch and the seven agent nodes):
 *
 *   Webhook (Header Auth, responds 202 immediately)
 *     → Route by agent (Switch on the request's `agent` field, one output per agent)
 *     → <Agent>: validate input → <Agent>: <stage 1> → … → <Agent>: build AI prompt
 *       (one Code node per pipeline stage of src/lib/agents/logic/<agent>.ts)
 *     → Use AI? (If: AI enabled and the agent asked for a narrative)
 *         true  → AI model API (HTTP: Anthropic or Groq, continues on error) → Finalize
 *         false → Finalize
 *     → Finalize (Code: merges AI text or falls back to computed text)
 *     → Report to dashboard (HTTP POST to the per-execution callback URL, retries 3×)
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { WORKFLOW_LOGIC } from "../src/lib/agents/logic";
import { AGENT_SLUGS, AGENTS, type AgentSlug } from "../src/lib/agents/registry";

const ROOT = path.resolve(__dirname, "..");
const LOGIC_DIR = path.join(ROOT, "src", "lib", "agents", "logic");
export const MASTER_WEBHOOK_PATH = "agent-dashboard";
const AI_CREDENTIAL = process.argv.includes("--ai-credential");

const LOGIC: Record<AgentSlug, { file: string; process: string; merge: string }> = {
  "data-analytics-agent": { file: "analytics", process: "analyzeDataset", merge: "mergeAnalyticsAi" },
  "email-automation-agent": { file: "email", process: "processEmails", merge: "mergeEmailAi" },
  "finance-audit-agent": { file: "finance", process: "auditFinance", merge: "mergeFinanceAi" },
  "crm-automation-agent": { file: "crm", process: "planCrmEvent", merge: "mergeCrmAi" },
  "data-advisory-agent": { file: "advisory", process: "advise", merge: "mergeAdvisoryAi" },
  "customer-support-agent": { file: "support", process: "answerSupport", merge: "mergeSupportAi" },
  "lead-generation-agent": { file: "leads", process: "scoreLeads", merge: "mergeLeadsAi" },
};

// Stable ids so credentials can be pre-created (see n8n/README.md). n8n asks
// you to pick a credential on import if these ids don't exist.
export const CREDENTIALS = {
  webhook: { id: "agentDashWebhookAuth", name: "Agent Dashboard Webhook Secret" },
  ai: { id: "agentDashAnthropicKey", name: "AI API Key" },
};

function agentEntry(slug: AgentSlug): string {
  const l = LOGIC[slug];
  return [
    `import { ${l.process}, ${l.merge} } from "./${l.file}";`,
    `import { makeN8nEntry } from "./n8n-entry";`,
    `const entry = makeN8nEntry(${l.process}, ${l.merge});`,
    `export const validate = (envelope) => entry.validate(envelope);`,
    `export const stage = (i, prev, envelope) => entry.stage(i, prev, envelope);`,
    `export const compute = (prev, envelope) => entry.compute(prev, envelope);`,
    `export const plan = (prev, envelope) => entry.plan(prev, envelope);`,
    `export const run = (envelope) => entry.process(envelope);`,
    `export const finish = (processed, ai) => entry.finalize(processed, ai);`,
  ].join("\n");
}

/** All seven agents behind one router keyed by envelope.agent. */
function masterEntry(): string {
  return [
    `import { WORKFLOW_LOGIC } from "./index";`,
    `export const run = (envelope) => {`,
    `  const agent = envelope && typeof envelope.agent === "string" ? envelope.agent : "";`,
    `  const entry = Object.keys(WORKFLOW_LOGIC).includes(agent) ? WORKFLOW_LOGIC[agent] : null;`,
    `  if (!entry) {`,
    `    return { ok: false, execution_id: envelope && typeof envelope.execution_id === "string" ? envelope.execution_id : null, result: null,`,
    `      error: { code: "UNKNOWN_AGENT", message: "This workflow has no agent named " + JSON.stringify(agent) + "." },`,
    `      use_ai: false, ai_url: null, ai_body: null, ai_headers: null };`,
    `  }`,
    `  return entry.process(envelope);`,
    `};`,
    `export const finish = (processed, ai, agent) => {`,
    `  const entry = Object.keys(WORKFLOW_LOGIC).includes(agent) ? WORKFLOW_LOGIC[agent] : WORKFLOW_LOGIC["data-analytics-agent"];`,
    `  return entry.finalize(processed, ai);`,
    `};`,
  ].join("\n");
}

async function bundle(label: string, contents: string): Promise<string> {
  const result = await build({
    stdin: {
      contents,
      resolveDir: LOGIC_DIR,
      loader: "ts",
      sourcefile: `${label}-entry.ts`,
    },
    bundle: true,
    // ESM, not IIFE: n8n's Code-node sandbox replaces Object.defineProperty
    // with a no-op, which breaks esbuild's IIFE export getters. We strip the
    // trailing `export { ... }` and bind a plain object instead.
    format: "esm",
    platform: "neutral",
    target: "es2020",
    write: false,
    legalComments: "none",
    minifyWhitespace: true,
    minifySyntax: true,
  });
  const text = result.outputFiles[0].text.trim();
  const m = /export\s*\{([^}]*)\};?\s*$/.exec(text);
  if (!m) throw new Error(`unexpected bundle shape for ${label}`);
  const bindings = m[1].split(",").map((part) => {
    const [local, exported] = part.trim().split(/\s+as\s+/);
    return `${exported ?? local}: ${local}`;
  });
  if (/defineProperty/.test(text)) throw new Error(`bundle for ${label} uses Object.defineProperty, which n8n's sandbox disables`);
  return `${text.slice(0, m.index).trim()}\nvar AgentLogic = { ${bindings.join(", ")} };`;
}

function uuid(seed: string): string {
  // Deterministic v4-shaped id so regenerated files diff cleanly.
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Node = Record<string, unknown> & { name: string };
type Connections = Record<string, { main: { node: string; type: string; index: number }[][] }>;
type WorkflowSpec = {
  key: string;
  name: string;
  webhookPath: string;
  source: string;
  /** Logic bundle used by Finalize (master: all agents). */
  code: string;
  /** Nodes between Webhook and "Use AI?", with their connections, and the JS expression Finalize uses to read the processed item. */
  head: { nodes: Node[]; connections: Connections; processedExpr: string; tailX: number };
};

function banner(source: string) {
  return `// Generated by scripts/build-n8n-workflows.ts from ${source}.\n// Do not edit here: change the TypeScript source and run \`npm run n8n:build\`.\n`;
}

function codeNode(id: string, name: string, position: [number, number], jsCode: string): Node {
  return { id, name, type: "n8n-nodes-base.code", typeVersion: 2, position, parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode } };
}

/** Per-agent files: one Code node runs the agent. */
function simpleHead(slug: string, source: string, code: string): WorkflowSpec["head"] {
  const node = codeNode(uuid(`${slug}:process`), "Validate and process", [240, 300], `${banner(source)}${code}\n\nconst envelope = $input.first().json.body;\nreturn [{ json: AgentLogic.run(envelope) }];`);
  return {
    nodes: [node],
    connections: {
      Webhook: { main: [[{ node: "Validate and process", type: "main", index: 0 }]] },
      "Validate and process": { main: [[{ node: "Use AI?", type: "main", index: 0 }]] },
    },
    processedExpr: "$('Validate and process').first().json",
    tailX: 480,
  };
}

/** Master: Switch on `agent`, then one Code node per pipeline stage of each agent (validate → real stages → AI prompt). */
function routedHead(bundles: Record<AgentSlug, string>): WorkflowSpec["head"] {
  const stepsFor = (slug: AgentSlug) => [
    { label: "validate input", fn: "AgentLogic.validate(envelope)" },
    ...WORKFLOW_LOGIC[slug].stageNames.map((name, i) => ({ label: name, fn: `AgentLogic.stage(${i}, $input.first().json, envelope)` })),
    { label: "build AI prompt", fn: "AgentLogic.plan($input.first().json, envelope)" },
  ];
  const nodeName = (slug: AgentSlug, label: string) => `${AGENTS[slug].name}: ${label}`;
  const colGap = 240;
  const rowGap = 160;
  const maxSteps = Math.max(...AGENT_SLUGS.map((slug) => stepsFor(slug).length));
  const top = 300 - (rowGap * (AGENT_SLUGS.length - 1)) / 2;
  const unknown = "Unknown agent";
  const nodes: Node[] = [
    {
      id: uuid("master:switch"),
      name: "Route by agent",
      type: "n8n-nodes-base.switch",
      typeVersion: 3.2,
      position: [240, 300],
      parameters: {
        rules: {
          values: AGENT_SLUGS.map((slug) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
              conditions: [{ id: uuid(`master:switch:${slug}`), leftValue: "={{ $json.body.agent }}", rightValue: slug, operator: { type: "string", operation: "equals" } }],
              combinator: "and",
            },
            renameOutput: true,
            outputKey: AGENTS[slug].name,
          })),
        },
        options: { fallbackOutput: "extra", renameFallbackOutput: unknown },
      },
    },
    ...AGENT_SLUGS.flatMap((slug, row) =>
      stepsFor(slug).map((step, i) =>
        codeNode(
          uuid(`master:${slug}:${i}`),
          nodeName(slug, step.label),
          [520 + i * colGap, top + row * rowGap],
          `${banner(`src/lib/agents/logic/${LOGIC[slug].file}.ts`)}${bundles[slug]}\n\nconst envelope = $('Webhook').first().json.body;\nreturn [{ json: ${step.fn} }];`,
        ),
      ),
    ),
    codeNode(uuid("master:unknown"), unknown, [520, top + AGENT_SLUGS.length * rowGap], [
      "const body = $input.first().json.body || {};",
      "return [{ json: { ok: false, execution_id: typeof body.execution_id === 'string' ? body.execution_id : null, result: null,",
      "  error: { code: 'UNKNOWN_AGENT', message: 'This workflow has no agent named ' + JSON.stringify(body.agent) + '.' },",
      "  use_ai: false, ai_url: null, ai_body: null, ai_headers: null } }];",
    ].join("\n")),
  ];
  const connections: Connections = {
    Webhook: { main: [[{ node: "Route by agent", type: "main", index: 0 }]] },
    "Route by agent": { main: [...AGENT_SLUGS.map((slug) => nodeName(slug, "validate input")), unknown].map((node) => [{ node, type: "main", index: 0 }]) },
    [unknown]: { main: [[{ node: "Use AI?", type: "main", index: 0 }]] },
  };
  const lastNode: Record<string, string> = {};
  for (const slug of AGENT_SLUGS) {
    const names = stepsFor(slug).map((step) => nodeName(slug, step.label));
    names.forEach((name, i) => {
      connections[name] = { main: [[{ node: i + 1 < names.length ? names[i + 1] : "Use AI?", type: "main", index: 0 }]] };
    });
    lastNode[slug] = names[names.length - 1];
  }
  return { nodes, connections, processedExpr: `$((${JSON.stringify(lastNode)})[$('Webhook').first().json.body.agent] || ${JSON.stringify(unknown)}).first().json`, tailX: 520 + maxSteps * colGap };
}

function workflow({ key: slug, name, webhookPath, source, code, head }: WorkflowSpec) {
  const nodes: Node[] = [
    {
      id: uuid(`${slug}:webhook`),
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 300],
      webhookId: uuid(`${slug}:webhook-id`),
      parameters: {
        httpMethod: "POST",
        path: webhookPath,
        authentication: "headerAuth",
        responseMode: "onReceived",
        responseCode: 202,
        options: { responseData: "noData" },
      },
      credentials: { httpHeaderAuth: CREDENTIALS.webhook },
    },
    ...head.nodes,
    {
      id: uuid(`${slug}:if`),
      name: "Use AI?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [head.tailX, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
          conditions: [
            {
              id: uuid(`${slug}:if-cond`),
              leftValue: "={{ $json.use_ai }}",
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    },
    {
      id: uuid(`${slug}:claude`),
      name: "AI model API",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [head.tailX + 240, 150],
      onError: "continueRegularOutput",
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 3000,
      parameters: {
        method: "POST",
        url: "={{ $json.ai_url }}",
        // Default: the API key comes from the environment n8n was started with
        // (GROQ_API_KEY / ANTHROPIC_API_KEY, needs N8N_BLOCK_ENV_ACCESS_IN_NODE=false).
        // --ai-credential: a Header Auth credential instead (n8n Cloud has no env vars).
        ...(AI_CREDENTIAL
          ? { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", sendHeaders: true, specifyHeaders: "json", jsonHeaders: "={{ JSON.stringify($json.ai_headers) }}" }
          : {
              sendHeaders: true,
              specifyHeaders: "json",
              jsonHeaders:
                "={{ JSON.stringify({ ...$json.ai_headers, ...($env.GROQ_API_KEY ? { Authorization: 'Bearer ' + $env.GROQ_API_KEY } : {}), ...($env.ANTHROPIC_API_KEY ? { 'x-api-key': $env.ANTHROPIC_API_KEY } : {}) }) }}",
            }),
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.ai_body) }}",
        options: { timeout: 180000 },
      },
      ...(AI_CREDENTIAL ? { credentials: { httpHeaderAuth: CREDENTIALS.ai } } : {}),
    },
    {
      id: uuid(`${slug}:finalize`),
      name: "Finalize",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [head.tailX + 480, 300],
      parameters: {
        mode: "runOnceForAllItems",
        language: "javaScript",
        jsCode: [
          `${banner(source)}${code}`,
          "",
          `const processed = ${head.processedExpr};`,
          "const request = $('Webhook').first().json.body;",
          "const callback = request.callback;",
          "const aiResponse = processed.use_ai ? $input.first().json : null;",
          "const body = { ...AgentLogic.finish(processed, aiResponse, request.agent), n8n_execution_id: String($execution.id) };",
          "return [{ json: { callback_url: callback.url, callback_token: callback.token, body } }];",
        ].join("\n"),
      },
    },
    {
      id: uuid(`${slug}:callback`),
      name: "Report to dashboard",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [head.tailX + 720, 300],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      parameters: {
        method: "POST",
        url: "={{ $json.callback_url }}",
        sendHeaders: true,
        headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $json.callback_token }}" }] },
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.body) }}",
        options: { timeout: 30000 },
      },
    },
  ];
  const connections: Connections = {
    ...head.connections,
    "Use AI?": {
      main: [
        [{ node: "AI model API", type: "main", index: 0 }],
        [{ node: "Finalize", type: "main", index: 0 }],
      ],
    },
    "AI model API": { main: [[{ node: "Finalize", type: "main", index: 0 }]] },
    Finalize: { main: [[{ node: "Report to dashboard", type: "main", index: 0 }]] },
  };
  return {
    id: uuid(`${slug}:workflow`).replace(/-/g, "").slice(0, 16),
    name,
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: "v1",
      // Successful runs are kept so the Executions tab shows every agent run
      // (demo value). Datasets, emails and customer messages pass through, so
      // switch to "none" for a shared or production n8n.
      saveDataSuccessExecution: "all",
      saveDataErrorExecution: "all",
      saveManualExecutions: true,
      executionTimeout: 600,
    },
    pinData: {},
    tags: [],
    meta: { templateCredsSetupCompleted: false, generatedBy: "ai-agent-dashboard" },
  };
}

async function write(file: string, wf: unknown, codeLength: number) {
  await mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  await writeFile(path.join(ROOT, file), `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`wrote ${file} (${Math.round(codeLength / 1024)} KB logic)`);
}

async function main() {
  if (process.argv.includes("--per-agent")) {
    for (const slug of AGENT_SLUGS) {
      const code = await bundle(slug, agentEntry(slug));
      const source = `src/lib/agents/logic/${LOGIC[slug].file}.ts`;
      const wf = workflow({ key: slug, name: `Agent Dashboard · ${AGENTS[slug].name}`, webhookPath: slug, source, code, head: simpleHead(slug, source, code) });
      await write(`n8n/workflows/${slug}.json`, wf, code.length);
    }
    return;
  }
  const code = await bundle("master", masterEntry());
  const bundles = {} as Record<AgentSlug, string>;
  for (const slug of AGENT_SLUGS) bundles[slug] = await bundle(slug, agentEntry(slug));
  const wf = workflow({ key: "master", name: "Agent Dashboard · All agents (master)", webhookPath: MASTER_WEBHOOK_PATH, source: "src/lib/agents/logic (all agents)", code, head: routedHead(bundles) });
  await write("n8n/agent-dashboard-master.json", wf, code.length + Object.values(bundles).join("").length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
