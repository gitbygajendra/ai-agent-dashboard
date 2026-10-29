# Run on Windows (everything local, no cloud accounts)

What you get: the dashboard on http://localhost:3000, n8n on http://localhost:5678, all seven agents in one n8n workflow. Only optional extra: a free Groq API key for AI-written text.

## 1. Install once

1. **Node.js** (LTS, 20 or newer): https://nodejs.org → run installer, keep defaults.
2. **PostgreSQL** (15 or newer): https://www.postgresql.org/download/windows/ → run installer. Remember the password you set for the `postgres` user. Keep port 5432.
3. Unzip the project, e.g. to `C:\ai-agent-dashboard`.

## 2. Set up the project

Open PowerShell in the project folder (Shift + right-click in the folder → "Open PowerShell window here") and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

It asks for the PostgreSQL password, creates the database, writes `.env.local` with random secrets, installs packages and runs the migrations. Takes a few minutes. At the end it prints the webhook secret you need for n8n.

## 3. Start n8n

In a **second** PowerShell window, same folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-n8n.ps1
```

(It runs `npx n8n` with your AI key from `.env.local` passed through.) First run downloads n8n (a few minutes). When it says `Editor is now accessible via: http://localhost:5678`, open that URL and create the owner account (any email/password, local only).

Then in n8n:

1. Left menu → **Credentials** → **Create** → search *Header Auth*: Name `Agent Dashboard Webhook Secret`, Name field `x-webhook-secret`, Value = the secret the setup script printed (also in `.env.local`, line `N8N_WEBHOOK_SECRET`).
   AI key: not a credential. Put `GROQ_API_KEY=gsk_...` in `.env.local` (free key at https://console.groq.com/keys) and restart n8n with the start script. Skip it if you don't want AI text; agents still work and say "AI unavailable".
2. Left menu → **Workflows** → **Create workflow** → `...` menu (top right) → **Import from File** → pick `n8n\agent-dashboard-master.json`.
3. Click the **Webhook** node → choose credential `Agent Dashboard Webhook Secret`. Close the panel.
4. **Save**, then **Publish** (top right). The canvas shows the full pipeline: Webhook → Route by agent → each agent's real steps (for example Data Analytics: detect columns → aggregate rows → trend by period → top items → find anomalies → compute KPIs → answer question) → Use AI? → AI model API → Finalize → Report to dashboard. 55 nodes.

## 4. Start the dashboard

Back in the first PowerShell window:

```powershell
npm run dev
```

Open http://localhost:3000 → **Sign up** (any email, password 8+ characters) → you are the workspace owner.

## 5. Demo script (5 minutes)

1. **AI Agents → Data Analytics** → upload `public\samples\sample-sales.csv` → Run. Watch n8n → **Executions** at the same time: the run lights up the Data Analytics branch. Result: KPIs, trend chart, anomalies, report.
2. **Finance Audit** → upload `sample-transactions.csv` and `sample-invoices.csv` → flags duplicates and unmatched invoices with row numbers.
3. **CRM** → **Load demo data** → open a contact → change a deal stage → a follow-up task appears (CRM agent ran in n8n).
4. **Lead Generation** → upload `sample-prospects.csv` → scored leads → approve → they appear in CRM.
5. **Customer Support** → add a knowledge article in Settings → ask a question → answer with citation.
6. **Settings** → turn an agent Off → its Run button is blocked. Turn it back On.

## Every day after that

Two PowerShell windows in the project folder: `.\scripts\start-n8n.ps1` in one, `npm run dev` in the other. PostgreSQL starts with Windows.

## If something fails

| Problem | Fix |
|---|---|
| `psql.exe not found` | Install PostgreSQL, or add `C:\Program Files\PostgreSQL\<version>\bin` to PATH |
| Dashboard says "n8n not reachable" | n8n window not running, or workflow not published |
| Run fails with `AUTH_FAILED` | Webhook credential value differs from `N8N_WEBHOOK_SECRET` in `.env.local` |
| Run fails with `WORKFLOW_NOT_FOUND` | Workflow imported but not published |
| Result says "AI unavailable" | No/invalid `GROQ_API_KEY` in `.env.local`, or n8n started with plain `npx n8n` instead of the start script. Everything else still works |
| Port 3000 or 5678 busy | Close the other program, or `set PORT=3001` before `npm run dev` |

Nothing leaves the laptop except the optional Groq call.
