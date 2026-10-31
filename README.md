# AI Agent Dashboard

One workspace with seven AI agents for a small business: data analytics, email, finance review, CRM automation, business advice, customer support and lead generation. Each agent runs as an **n8n** workflow. The dashboard handles auth, validation, storage, approvals, history and results.

Stack: Next.js 16 (App Router, TypeScript) · Tailwind CSS v4 with shadcn/ui-style components · Lucide · Recharts · Supabase Postgres + Auth + Storage · n8n · Anthropic Claude (called from n8n).

## Run it anywhere (no setup)

Needs only Node.js 20+ (Windows, macOS or Linux). No database, no n8n, no accounts, no sign-in:

```bash
git clone https://github.com/gitbygajendra/ai-agent-dashboard.git
cd ai-agent-dashboard
npm install
npm run dev
```

Open http://localhost:3000. With no `.env.local` the app runs in **standalone mode**:

- **Database:** PGlite, real Postgres compiled to WebAssembly, runs inside the app. Data lives in `.data/db` (delete that folder to start over). Same schema and row-level security as the full setup.
- **Agents:** the built-in engine runs each agent's step-by-step pipeline in the app, the same code the n8n workflow runs. Each agent page lists its steps.
- **No sign-in:** you are the workspace owner. Only for your own computer; the app refuses to start this way in production.
- **AI text (optional):** create `.env.local` with `GROQ_API_KEY=gsk_...` (free at https://console.groq.com/keys) or `ANTHROPIC_API_KEY=...` and restart. Without a key every agent still works and labels results "AI unavailable".

Sample files are in `public/samples/`. Setting `DATABASE_URL` and/or `N8N_BASE_URL` switches to the full setup below.

## Agent status

| Agent | Status | Works without extra setup | Needs |
|---|---|---|---|
| Data Analytics | **Fully implemented** | CSV/XLSX upload → KPIs, trend and top-item charts, anomalies, month-scoped answers, Markdown report | n8n |
| Finance Audit | **Fully implemented** | Categorization, duplicates, invoice reconciliation, unusual expenses, monthly summary, CSV + Markdown export. Every flag cites file + row numbers | n8n |
| CRM Automation | **Fully implemented** | New lead → follow-up task + intro email *draft*; qualified → discovery task; deal stage moves → stage tasks; won → contact becomes customer | n8n |
| Data-Driven Advisory | **Fully implemented** | Recommendations derived from your CRM/analytics/finance records, each with evidence, assumptions, risks, confidence; saved with status | n8n |
| Customer Support | **Partial** | Grounded answers from your knowledge base with citations, intent/urgency, escalation + ticket, conversation history | n8n. Order lookups need an order system; embeddable website widget not built |
| Lead Generation | **Partial** | CSV prospects → dedupe, opt-out exclusion, scoring, segments, outreach drafts, push approved leads to CRM | n8n. Live prospect search needs an authorized data provider |
| Email Automation | **Partial** | Pasted emails → category, priority, summary, action items, entities, reply drafts | n8n. Reading the inbox and sending need Gmail OAuth credentials |

Without an AI key in n8n, every agent still works and returns computed results labelled "AI unavailable". With one (Anthropic Claude, or Groq via `AI_PROVIDER=groq`), the model writes the summaries, answers and drafts from the computed figures only.

Nothing external happens without a person approving it. Email drafts and CRM lead imports wait in "Needs approval". The only exception is an opt-in auto-send rule for email categories an admin explicitly trusts (Settings, off by default, audited).

## How a run works

```
Browser ──POST /api/agents/:slug/run──▶ Next.js API route
                                          │ 1. authenticate (Supabase Auth) + org membership/role
                                          │ 2. validate input, file type/size, rate limit, idempotency key
                                          │ 3. store upload in private storage, insert agent_executions (RLS)
                                          │ 4. POST n8n webhook (x-webhook-secret, idempotency-key)
                                          ▼
                                        n8n workflow ──(optional) AI model API (Anthropic/Groq)
                                          │
                       POST /api/n8n/callback/:id (single-use bearer token)
                                          ▼
                     validate result → apply to records (tasks, recommendations, tickets)
                     → status succeeded / awaiting_approval / failed
Browser polls GET /api/executions/:id ◀───┘
```

- Runs are asynchronous. n8n answers 202 at once; the result arrives on the callback. Runs that never call back are marked **timed out** after `EXECUTION_TIMEOUT_MS`.
- The n8n client (`src/lib/n8n/client.ts`) normalizes errors (not configured, unreachable, auth failed, workflow missing, upstream error, timeout). It retries only when the request provably never reached n8n.
- Retries create a new run linked with `retry_of`, rebuilt from the stored input.
- One master n8n workflow serves all seven agents; it routes on the `agent` field of each request. (`npm run n8n:build -- --per-agent` generates separate workflows if you prefer.)
- The agent logic lives in `src/lib/agents/logic/*.ts`: pure, unit-tested TypeScript split into named stages (`*_STAGES`). `npm run n8n:build` turns every stage into its own n8n Code node, so the canvas shows each agent's real steps.

## Quick start (local, no external accounts)

**Windows:** see [WINDOWS-SETUP.md](WINDOWS-SETUP.md) (installer links, a setup script and a demo script).

Requirements: Node 24+, PostgreSQL 14+, and n8n (2.x). n8n can run through npm, without Docker.

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```
DATABASE_URL=postgres://postgres@127.0.0.1:5432/agentdash
AUTH_MODE=local
LOCAL_AUTH_SECRET=<openssl rand -base64 48>
ENCRYPTION_KEY=<openssl rand -base64 32>
N8N_BASE_URL=http://localhost:5678
N8N_WEBHOOK_SECRET=<openssl rand -hex 32>
```

Create the database and apply the migrations. `--local` first installs a small shim (auth schema, `auth.uid()`, Supabase roles) so the real migrations and RLS run on plain Postgres:

```bash
createdb agentdash
```

```bash
npm run db:migrate:local
```

Set up n8n as described in [n8n/README.md](n8n/README.md): two credentials, then import and publish the single master workflow `n8n/agent-dashboard-master.json`. Then:

```bash
npm run dev
```

Open http://localhost:3000, create an account, open **AI Agents → Data Analytics** and upload `public/samples/sample-sales.csv`. More sample files (fictional data) are in `public/samples/`: transactions + invoices for Finance and prospects for Lead Generation. **CRM → Load demo data** adds records clearly marked "Demo".

`AUTH_MODE=local` (signed cookie + bcrypt in Postgres) exists only for development. The app refuses to run with it when `NODE_ENV=production` (which includes `next build`); set `ALLOW_LOCAL_AUTH=true` only to test a production build locally.

## Production setup

1. **Supabase**: create a project and run the migrations with `supabase db push` (or `DATABASE_URL=… npm run db:migrate`). This creates the tables, RLS policies and the private `agent-files` bucket. Under Auth → URL configuration, add your site URL.
2. **Environment** (Vercel → Settings → Environment Variables): every variable in `.env.example`, with `AUTH_MODE=supabase`, `DATABASE_URL` set to the **transaction pooler** URL, `DATABASE_SSL=true`, and `SUPABASE_SERVICE_ROLE_KEY` as a server-only variable.
3. **n8n**: host it securely (n8n Cloud or your own server behind HTTPS), import and publish `n8n/agent-dashboard-master.json`, and add the credentials. It must reach `APP_BASE_URL`.
4. **Deploy** to Vercel (`vercel deploy`). API routes run on the Node.js runtime.
5. **Optional integrations**: see the checklist below.

## Integration checklist

| # | Item | Where | Unlocks |
|---|---|---|---|
| 1 | Supabase project, migrations applied | Supabase | Auth, database, RLS, storage |
| 2 | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` | Hosting env | Sign-in, data |
| 3 | `ENCRYPTION_KEY` | Hosting env | Encrypted OAuth token storage |
| 4 | n8n instance + `N8N_BASE_URL` + `N8N_WEBHOOK_SECRET` | Hosting env + n8n | All agents |
| 5 | n8n credential "Agent Dashboard Webhook Secret" (Header Auth, `x-webhook-secret`) | n8n | Webhook authentication |
| 6 | Import + publish `n8n/agent-dashboard-master.json` (one workflow for all 7 agents) | n8n | Every agent |
| 7 | AI key: `GROQ_API_KEY` / `ANTHROPIC_API_KEY` in n8n's environment (self-hosted), or Header Auth credential "AI API Key" with a `--ai-credential` build (n8n Cloud); `AI_PROVIDER` in the dashboard env | n8n | AI summaries, answers, drafts |
| 8 | Google OAuth client (`GOOGLE_CLIENT_ID`/`SECRET`, redirect `${APP_BASE_URL}/api/integrations/gmail/callback`, Gmail API enabled, scopes `gmail.readonly` + `gmail.send`) | Google Cloud + env | Email inbox + sending |
| 9 | Lead data provider (e.g. Apollo/Clearbit) under its API terms | New integration | Live prospect search *(not built)* |
| 10 | Order system (Shopify/WooCommerce/API) via an n8n sub-workflow | New integration | Order-status answers *(not built)* |

The **Integrations** page shows each connection as Connected, Not connected or Needs attention, and **Settings → Setup checklist** tracks progress.

### Features that need external credentials or provider setup

- Everything: an n8n instance (self-hosted or n8n Cloud).
- AI narratives, AI answers to free-form questions, AI-written drafts: an Anthropic or Groq API key (stored in n8n).
- Gmail inbox processing and sending approved replies: a Google Cloud OAuth client, and Google's verification for production use of restricted Gmail scopes.
- Live lead search: an authorized B2B data provider (not implemented; CSV import works).
- Support order-status lookups: an order system integration (not implemented; the bot escalates instead of guessing).
- Hosted auth, storage and database: a Supabase project.

## Security

- **Tenant isolation**: every table carries `organization_id`; RLS policies on every user-accessible table (`supabase/migrations/…_rls_policies.sql`). User queries run as the `authenticated` role with the user's JWT claims (`src/lib/db.ts`), so RLS applies exactly as through PostgREST. Composite foreign keys stop cross-tenant references (e.g. a deal pointing at another org's contact). `tests/rls.test.ts` verifies isolation.
- **Server-only writes**: execution status/results, integration status, recommendations and audit logs are written by the server role after authorization in code.
- **Secrets**: kept in environment variables and n8n credentials. OAuth tokens are AES-256-GCM encrypted in `integration_secrets`, which has no client policies or privileges. The callback token hash column is not selectable by clients. Nothing secret reaches the browser bundle; `server-only` guards server modules.
- **Inputs**: zod validation on every route; CSV/XLSX type, magic-byte, size and row checks; CSV export guards against formula injection.
- **Abuse**: per-user agent run limit (counted in the database), per-user API budget, sign-in/sign-up limits, same-origin checks on writes, security headers.
- **Reliability**: idempotency keys (unique per org), single-use callbacks, timeouts, safe retries, error boundaries and user-facing error messages.
- **Logging**: structured JSON with redaction of secret-like keys and email addresses. Never logs datasets or message bodies.
- **Audit log**: sign-ins, runs, sends, imports/exports, deletes, settings and integration changes (Settings → Audit log, admins).
- **Honesty rules**: agents never invent transactions, policies, order statuses, prospects or metrics. Finance findings cite source rows and are labelled "not a formal audit". Advisory separates verified metrics from assumptions. Demo data is flagged everywhere.

## Testing

```bash
npm test
```

Unit tests cover the agent logic, the n8n client, crypto, sessions, rate limiting, file parsing and redaction. The RLS integration tests run against a database:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/agentdash npx vitest run tests/rls.test.ts
```

Also: `npm run typecheck`, `npm run lint`, `npm run build`.

## Project structure

```
src/app/(auth)            sign in / sign up
src/app/(app)             dashboard, agents, analytics, crm, integrations, runs, settings
src/app/api               route handlers (agents, executions, n8n callback, crm, knowledge, integrations, settings, auth)
src/lib/agents/logic      pure agent logic (bundled into n8n)
src/lib/agents/handlers   per-agent input preparation and result application
src/lib/agents            execution service, approvals, registry
src/lib/n8n               n8n client
src/lib/integrations      Gmail OAuth, integration status
src/components            UI primitives, charts, agent panels, CRM
supabase/migrations       schema, RLS, storage bucket
n8n/agent-dashboard-master.json   importable master workflow for all agents (generated)
scripts                   migration runner, n8n workflow builder
tests                     vitest suites
```

## Known limitations

- Rate limiting for sign-in and general API traffic is in-memory per instance. For multiple instances, use a shared store (Upstash/Redis); agent-run limits are already database-backed.
- Knowledge-base retrieval uses Postgres full-text search. pgvector embeddings can be added behind `searchKnowledge()`.
- Invitations and member management UI are not built; memberships can be added in the database.
- The website chat widget, live lead search and order lookups are not built (see the agent status table).
