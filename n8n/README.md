# n8n workflow

**One file runs all seven agents: [`agent-dashboard-master.json`](agent-dashboard-master.json).** Import it once, publish it, and every agent works.

It is generated from the TypeScript logic in `src/lib/agents/logic/` by `npm run n8n:build`. Don't edit the Code nodes in n8n; change the TypeScript, rebuild and re-import.

## Setup (about 5 minutes)

1. **Create one credential** in n8n (Credentials → New → *Header Auth*): name `Agent Dashboard Webhook Secret`, header `x-webhook-secret`, value = the dashboard's `N8N_WEBHOOK_SECRET`.

   **AI key** (optional): the AI node reads `GROQ_API_KEY` or `ANTHROPIC_API_KEY` from n8n's environment, so start n8n with that variable set and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (`scripts/start-n8n.ps1` does both on Windows). On **n8n Cloud** there is no environment: build with `npm run n8n:build -- --ai-credential` and add a second Header Auth credential `AI API Key` (`x-api-key` for Anthropic, or `Authorization` = `Bearer <key>` for Groq), then pick it on the **AI model API** node. Without a key every agent still works and returns computed results, marked "AI unavailable".
2. **Import** `agent-dashboard-master.json` (Workflows → Import from file). If n8n asks, pick the credential on the **Webhook** node (and on **AI model API** in `--ai-credential` builds).
3. **Publish** (activate) the workflow.
4. **Configure the dashboard**: set `N8N_BASE_URL` (e.g. `https://n8n.yourcompany.com`) and `N8N_WEBHOOK_SECRET`. The dashboard calls `${N8N_BASE_URL}/webhook/agent-dashboard`. Use `N8N_MASTER_WEBHOOK_URL` instead if your webhook URL differs.
5. **Network**: n8n must reach the dashboard's `APP_BASE_URL` (for result callbacks), and the dashboard must reach n8n.

## How it routes

Every request carries the agent name, and the workflow picks the matching logic:

```
Webhook  POST /webhook/agent-dashboard  (Header Auth, responds 202 immediately)
  → Route by agent         Switch on body.agent: one output per agent, "Unknown agent" fallback
  → <Agent>: validate input → <Agent>: <stage> → … → <Agent>: build AI prompt
                           one Code node per real pipeline stage (55 nodes in all); a stage that fails or
                           finishes early (e.g. an escalation) passes its result straight through to Finalize
  → Use AI?                If: AI enabled and the agent asked for a narrative
      ├─ true  → AI model API (HTTP to Anthropic or Groq, continue on error, 2 tries) → Finalize
      └─ false → Finalize
  → Finalize               Code: merges AI text, or keeps computed text if AI failed/refused
  → Report to dashboard    HTTP POST to the per-run callback URL (Bearer token), 3 tries
```

| `agent` value | Agent |
|---|---|
| `data-analytics-agent` | Data Analytics |
| `email-automation-agent` | Email Automation |
| `finance-audit-agent` | Finance Audit |
| `crm-automation-agent` | CRM Automation |
| `data-advisory-agent` | Data-Driven Advisory |
| `customer-support-agent` | Customer Support |
| `lead-generation-agent` | Lead Generation |

An unknown `agent` value fails the run with `UNKNOWN_AGENT` and reports back to the dashboard.

Stages per agent (each is a node; the names come from `*_STAGES` in `src/lib/agents/logic/`):

| Agent | Stages |
|---|---|
| Data Analytics | detect columns → aggregate rows → trend by period → top items and categories → find anomalies → compute KPIs → answer question |
| Email Automation | parse emails → classify emails → extract actions, entities and priority → draft replies |
| Finance Audit | detect columns → categorize transactions → find duplicates → flag unusual expenses → reconcile invoices → monthly summary |
| CRM Automation | read event → plan tasks → draft intro email |
| Data-Driven Advisory | collect metrics → detect signals → rank and select recommendations → write narrative |
| Customer Support | classify intent and urgency → search knowledge base → decide escalation → compose answer with citations |
| Lead Generation | parse prospects → remove duplicates → exclude opt-outs → score leads → segment → draft outreach |

`tests/logic-stages.test.ts` runs every pipeline stage by stage with a JSON round-trip between stages (as n8n does) and requires the same result as the in-process function.

The per-agent files (`npm run n8n:build -- --per-agent`) use a single "Validate and process" node instead of the Switch and agent nodes.

- **Request** (from the dashboard): `{ execution_id, agent, organization_id, callback: { url, token }, ai: { enabled, model }, input }`, with headers `x-webhook-secret`, `idempotency-key` and `x-execution-id`.
- **Callback** (to the dashboard): `{ status: "succeeded" | "failed", result, error: { code, message } | null, ai_status: "used" | "skipped" | "unavailable", n8n_execution_id }`.
- The callback token is random, generated per run and accepted once (the dashboard stores only its SHA-256). n8n never receives database, Gmail or Supabase credentials.
- Every execution is saved in n8n so the Executions tab shows each run (good for demos). Datasets, emails and customer messages pass through, so on a shared or production n8n set `saveDataSuccessExecution` to "none" in the workflow settings (or in `scripts/build-n8n-workflows.ts`).

## CLI import (self-hosted)

```bash
n8n import:credentials --input=credentials.json   # [{ id, name, type: "httpHeaderAuth", data: { name, value } }]
n8n import:workflow --input=n8n/agent-dashboard-master.json
n8n list:workflow                                  # find the master's id, then:
n8n publish:workflow --id=<id>
```

Use credential ids `agentDashWebhookAuth` and `agentDashAnthropicKey` so the imported nodes pick them up automatically.

## One workflow per agent (optional)

If you'd rather scale or monitor agents separately, `npm run n8n:build -- --per-agent` writes seven workflows to `n8n/workflows/` (webhook path = agent name). Set `N8N_WORKFLOW_MODE=per-agent` in the dashboard. Per-agent URL overrides (`N8N_WEBHOOK_URL_*`) work in either mode.

## AI model

The request is built in `src/lib/agents/logic/n8n-entry.ts` and the node reads URL, headers and body from it, so no node edits are needed to switch providers. `AI_PROVIDER=groq` sends an OpenAI-style chat completion to `https://api.groq.com/openai/v1/chat/completions` (model from `AI_MODEL`, default `llama-3.3-70b-versatile`). `AI_PROVIDER=anthropic` uses the Messages API (default `claude-opus-5-5`) and also sets `fallbacks: "default"` with beta header `server-side-fallback-2026-07-01` for models that support server-side refusal fallbacks. Refusals, errors and truncated answers fall back to the computed text. Prompts tell the model to use only the supplied figures and records.

## Notes

- n8n's Code-node sandbox disables `Object.defineProperty`. The build script bundles the logic as ESM and binds a plain object for that reason, and it fails the build if a bundle would need `defineProperty`.
- Tested against n8n 2.43.6 (Webhook v2, Code v2, If v2.2, HTTP Request v4.2).
