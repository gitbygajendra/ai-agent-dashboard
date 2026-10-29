import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_LOGIC } from "@/lib/agents/logic";
import type { WorkflowEnvelope } from "@/lib/agents/logic/n8n-entry";

/**
 * Every agent runs as one n8n Code node per pipeline stage, and n8n passes
 * the state between nodes as JSON. These tests run each pipeline stage by
 * stage with a JSON round-trip in between and require the exact same result
 * as the in-process function.
 */

function csv(file: string) {
  const text = readFileSync(path.join(__dirname, "..", "public", "samples", file), "utf8").trim();
  const parseLine = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [header, ...lines] = text.split(/\r?\n/);
  const columns = parseLine(header);
  const rows = lines.map((l) => Object.fromEntries(parseLine(l).map((v, i) => [columns[i], v])));
  return { name: file, columns, rows };
}

const INPUTS: Record<keyof typeof WORKFLOW_LOGIC, unknown[]> = {
  "data-analytics-agent": [
    { dataset: csv("sample-sales.csv"), question: "What was the top product last month?", currency: "INR" },
    { dataset: { name: "x.csv", columns: ["a"], rows: [{ a: "text" }] } },
  ],
  "finance-audit-agent": [
    { transactions: csv("sample-transactions.csv"), invoices: csv("sample-invoices.csv"), currency: "INR" },
    { transactions: { name: "t.csv", columns: ["x"], rows: [] } },
  ],
  "lead-generation-agent": [
    { source: "csv", prospects: csv("sample-prospects.csv"), criteria: { industries: ["gifting"] }, existing_emails: ["riya@giftory.example"], sender: { name: "Gaj", company: "Cladure" } },
    { source: "provider" },
  ],
  "email-automation-agent": [
    { emails: [{ id: "1", from: "Priya <priya@client.com>", subject: "Invoice 2041 overdue", body: "Your invoice 2041 for $1,200 is overdue. Please pay by Friday.", source: "pasted" }], sender_name: "Gaj" },
    { emails: [] },
  ],
  "crm-automation-agent": [
    { event: "contact.created", contact: { id: "c1", name: "Riya Bansal", email: "riya@example.com", company: "Giftory", status: "lead", source: "web" }, sender_name: "Gaj" },
    { event: "deal.stage_changed", deal: { id: "d1", title: "Hampers", stage: "won", previous_stage: "negotiation", value: 1000, currency: "INR" }, contact: { id: "c1", name: "Riya", email: null, company: null, status: "qualified" } },
    { event: "nope" },
  ],
  "customer-support-agent": [
    { message: "What is your refund policy?", knowledge: [{ document_id: "k1", title: "Refunds", chunk_index: 0, content: "Refunds within 14 days.", rank: 0.5 }], customer: { email: "a@b.com" } },
    { message: "I want to talk to a human", knowledge: [] },
    { message: "" },
  ],
  "data-advisory-agent": [
    {
      question: "How can I grow?",
      metrics: {
        crm: { contacts_total: 40, by_status: { lead: 30, qualified: 5, customer: 2 }, by_source: [], overdue_tasks: 4, open_tasks: 6, demo_records: 0 },
        deals: { open_count: 6, open_value: 90000, won_count: 2, won_value: 30000, lost_count: 1, by_stage: [], stale_count: 3, stale_value: 40000, stale_days: 14 },
        analytics: null,
        finance: null,
        automation: { runs_30d: 10, failed_30d: 1 },
      },
    },
  ],
};

const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("stage pipelines match the in-process functions through JSON boundaries", () => {
  for (const slug of Object.keys(WORKFLOW_LOGIC) as (keyof typeof WORKFLOW_LOGIC)[]) {
    const entry = WORKFLOW_LOGIC[slug];
    it(`${slug}: ${entry.stageNames.length} stages (${entry.stageNames.join(" → ")})`, () => {
      expect(entry.stageNames.length).toBeGreaterThanOrEqual(3);
      for (const input of INPUTS[slug]) {
        const envelope: WorkflowEnvelope = {
          execution_id: "11111111-1111-4111-8111-111111111111",
          agent: slug,
          organization_id: "22222222-2222-4222-8222-222222222222",
          callback: { url: "https://app.example/cb", token: "t" },
          ai: { enabled: true, model: "", provider: "groq" },
          input,
        };
        const direct = entry.process(envelope);
        let item = roundTrip(entry.validate(envelope));
        for (let i = 0; i < entry.stageNames.length; i++) item = roundTrip(entry.stage(i, item, roundTrip(envelope)));
        const staged = entry.plan(item as never, envelope);
        expect(staged).toEqual(roundTrip(direct));
      }
    });
  }
});
