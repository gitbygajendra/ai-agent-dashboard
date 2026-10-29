import { describe, expect, it } from "vitest";
import type { LogicOutput } from "@/lib/agents/logic/common";
import { mergeLeadsAi, scoreLeads, type LeadInput } from "@/lib/agents/logic/leads";
import { latestMessageText, processEmails, type EmailMessage } from "@/lib/agents/logic/email";
import { answerSupport, mergeSupportAi, type KnowledgeChunk } from "@/lib/agents/logic/support";
import { advise, type BusinessMetrics } from "@/lib/agents/logic/advisory";
import { planCrmEvent, type CrmEventInput } from "@/lib/agents/logic/crm";
import { buildClaudeRequest, buildGroqRequest, makeN8nEntry, type WorkflowEnvelope } from "@/lib/agents/logic/n8n-entry";
import { readClaudeText } from "@/lib/agents/logic/common";
import { analyzeDataset, mergeAnalyticsAi } from "@/lib/agents/logic/analytics";
import { WORKFLOW_LOGIC } from "@/lib/agents/logic";

function unwrap<R>(out: LogicOutput<R>) {
  if (!out.ok) throw new Error(`expected ok, got ${out.error.code}: ${out.error.message}`);
  return out;
}

function claudeText(text: string, stop_reason = "end_turn") {
  return { type: "message", role: "assistant", stop_reason, content: [{ type: "text", text }] };
}

const UNSUBSCRIBE_LINE = `If you'd prefer not to hear from us, reply "unsubscribe" and we won't contact you again.`;

// ---------------------------------------------------------------------------
// leads.ts
// ---------------------------------------------------------------------------

describe("scoreLeads", () => {
  const input: LeadInput = {
    source: "csv",
    prospects: {
      name: "prospects.csv",
      columns: ["Name", "Email", "Company", "Title", "Industry", "City", "Employees", "Unsubscribed"],
      rows: [
        /* row 2 */ { Name: "Asha Rao", Email: "asha@acme.io", Company: "Acme Software", Title: "CEO", Industry: "Software", City: "Bengaluru", Employees: "11-50", Unsubscribed: "no" },
        /* row 3 */ { Name: "Ben Lee", Email: "ben@beta.com", Company: "Beta Foods", Title: "Analyst", Industry: "Food", City: "Mumbai", Employees: "200+", Unsubscribed: "no" },
        /* row 4 */ { Name: "Asha Rao", Email: "ASHA@ACME.IO", Company: "Acme Software", Title: "CEO", Industry: "Software", City: "Bengaluru", Employees: "11-50", Unsubscribed: "" },
        /* row 5 */ { Name: "Carl Diaz", Email: "carl@crm.com", Company: "Gamma Software", Title: "Founder", Industry: "Software", City: "Bengaluru", Employees: "11-50", Unsubscribed: "no" },
        /* row 6 */ { Name: "Dana Fox", Email: "dana@delta.io", Company: "Delta Software", Title: "CTO", Industry: "Software", City: "Bengaluru", Employees: "11-50", Unsubscribed: "yes" },
        /* row 7 */ { Name: "", Email: "not-an-email", Company: "", Title: "", Industry: "", City: "", Employees: "", Unsubscribed: "" },
      ],
    },
    criteria: { industries: ["software"], locations: ["Bengaluru"], company_sizes: ["11-50"], min_score: 60 },
    existing_emails: ["CARL@crm.com"],
    sender: { name: "Gaj", company: "Cladure", offering: "workflow automation" },
  };
  const { result, ai_request } = unwrap(scoreLeads(input));
  const byRow = (row: number) => result.prospects.find((p) => p.row === row)!;

  it("scores against the criteria with reasons", () => {
    const asha = byRow(2);
    // industry 30 + location 25 + size 15 + email 10 + decision maker 5
    expect(asha.score).toBe(85);
    expect(asha.qualified).toBe(true);
    expect(asha.status).toBe("new");
    expect(asha.reasons).toEqual([
      'Industry matches "software"',
      'Location matches "Bengaluru"',
      'Company size matches "11-50"',
      "Has a valid email",
      "Decision-maker title",
    ]);
    const ben = byRow(3);
    expect(ben.score).toBe(10);
    expect(ben.qualified).toBe(false);
    expect(ben.outreach_draft).toBeNull();
    expect(result.prospects[0].row).toBe(2); // qualified first
  });

  it("dedupes within the file (case-insensitive email)", () => {
    expect(byRow(4).status).toBe("duplicate_in_file");
    expect(byRow(4).qualified).toBe(false);
    expect(byRow(4).outreach_draft).toBeNull();
  });

  it("marks emails already in the CRM as duplicate_in_crm", () => {
    expect(byRow(5).status).toBe("duplicate_in_crm");
    expect(byRow(5).qualified).toBe(false);
    expect(byRow(5).outreach_draft).toBeNull();
  });

  it('excludes opted-out prospects via an "unsubscribed" column', () => {
    expect(byRow(6).status).toBe("opted_out");
    expect(byRow(6).qualified).toBe(false);
    expect(byRow(6).outreach_draft).toBeNull();
  });

  it("counts exclusions and invalid rows", () => {
    expect(result.excluded).toEqual({ duplicate_in_crm: 1, duplicate_in_file: 1, opted_out: 1, invalid: 1 });
    expect(result.qualified_count).toBe(1);
    expect(result.total_rows).toBe(6);
  });

  it("drafts include the unsubscribe line and nothing is drafted for excluded prospects", () => {
    const drafted = result.prospects.filter((p) => p.outreach_draft);
    expect(drafted.map((p) => p.row)).toEqual([2]);
    const body = drafted[0].outreach_draft!.body;
    expect(body).toContain(UNSUBSCRIBE_LINE);
    expect(body).toContain("Hi Asha,");
    expect(body).toContain("workflow automation");
    expect(drafted[0].outreach_draft!.subject).toBe("Cladure × Acme Software");
    expect(ai_request).not.toBeNull();
    expect(ai_request!.prompt).not.toContain("dana@delta.io");
  });

  it("PROVIDER_NOT_CONNECTED when source is provider without data", () => {
    expect(scoreLeads({ source: "provider" })).toMatchObject({ ok: false, error: { code: "PROVIDER_NOT_CONNECTED" } });
    expect(scoreLeads({ source: "provider", prospects: null })).toMatchObject({ ok: false, error: { code: "PROVIDER_NOT_CONNECTED" } });
  });

  it("mergeLeadsAi keeps the unsubscribe line when the model drops it", () => {
    const id = byRow(2).id;
    const merged = mergeLeadsAi(
      result,
      claudeText(JSON.stringify({ drafts: [{ id, subject: "Quick idea for Acme", body: "Hi Asha,\n\nShort pitch.\n\nBest,\nGaj" }] })),
    );
    expect(merged.ai_generated).toBe(true);
    const draft = merged.prospects.find((p) => p.id === id)!.outreach_draft!;
    expect(draft.subject).toBe("Quick idea for Acme");
    expect(draft.body.startsWith("Hi Asha,\n\nShort pitch.")).toBe(true);
    expect(draft.body).toContain(UNSUBSCRIBE_LINE);
  });

  it("mergeLeadsAi never adds drafts for prospects without one", () => {
    const merged = mergeLeadsAi(result, claudeText(JSON.stringify({ drafts: [{ id: byRow(6).id, subject: "Hi", body: "Hello" }] })));
    expect(merged.prospects.find((p) => p.row === 6)!.outreach_draft).toBeNull();
  });

  it("mergeLeadsAi returns the computed result on refusal", () => {
    expect(mergeLeadsAi(result, claudeText("no", "refusal"))).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// email.ts
// ---------------------------------------------------------------------------

describe("processEmails", () => {
  const mk = (id: string, from: string, subject: string, body: string): EmailMessage => ({ id, from, subject, body, source: "pasted" });
  const emails: EmailMessage[] = [
    mk("billing", "Priya Shah <priya@client.com>", "Invoice 2041 overdue", "Hi,\n\nYour invoice 2041 for $1,200 is overdue. Please send payment by Friday.\n\nThanks,\nPriya"),
    mk("support", "sam@user.com", "App not working", "I get an error when I log in. Can you help?"),
    mk("scheduling", "Lee <lee@x.com>", "Catch up", "Can we reschedule our meeting to Tuesday afternoon?"),
    mk("sales", "buyer@corp.com", "Pricing for bulk order", "We are interested in a quote for 500 units."),
    mk("newsletter", "Deals <no-reply@shop.com>", "This week's deals", "Big savings inside. View in browser. Unsubscribe anytime."),
    mk("inquiry", "kim@home.org", "Shipping to Canada", "Do you ship to Canada?"),
    mk("other", "team@us.com", "Lunch", "Team lunch was great."),
  ];
  const { result, ai_request } = unwrap(processEmails({ emails, sender_name: "Gaj" }));
  const get = (id: string) => result.emails.find((e) => e.id === id)!;

  it("classifies categories", () => {
    expect(Object.fromEntries(result.emails.map((e) => [e.id, e.category]))).toEqual({
      billing: "billing",
      support: "support",
      scheduling: "scheduling",
      sales: "sales_lead",
      newsletter: "newsletter",
      inquiry: "customer_inquiry",
      other: "other",
    });
  });

  it("newsletters get no draft, no follow-up and low priority", () => {
    const n = get("newsletter");
    expect(n.draft).toBeNull();
    expect(n.needs_reply).toBe(false);
    expect(n.follow_up).toBeNull();
    expect(n.priority).toBe("low");
  });

  it("extracts action items, entities and drafts a reply for actionable mail", () => {
    const b = get("billing");
    expect(b.action_items).toEqual(["Please send payment by Friday."]);
    expect(b.priority).toBe("high"); // "overdue"
    expect(b.entities.amounts).toEqual(["$1,200"]);
    expect(b.entities.dates).toContain("Friday");
    expect(b.from_name).toBe("Priya Shah");
    expect(b.from_email).toBe("priya@client.com");
    expect(b.draft).not.toBeNull();
    expect(b.draft!.to).toBe("priya@client.com");
    expect(b.draft!.subject).toBe("Re: Invoice 2041 overdue");
    expect(b.draft!.body).toContain("Hi Priya,");
    expect(b.draft!.body).toContain("• Please send payment by Friday.");
    expect(b.draft!.body.trim().endsWith("Gaj")).toBe(true);
    expect(get("support").action_items).toEqual(["Can you help?"]);
  });

  it("requires approval and counts drafts", () => {
    expect(result.approval_required).toBe(true);
    expect(result.counts.total).toBe(7);
    expect(result.counts.drafts).toBe(5); // all except newsletter and "other"
    expect(get("other").draft).toBeNull();
    expect(ai_request).not.toBeNull();
  });

  it("fails on empty input", () => {
    expect(processEmails({ emails: [] })).toMatchObject({ ok: false, error: { code: "NO_EMAILS" } });
    expect(processEmails({} as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

describe("latestMessageText", () => {
  it("strips quoted replies after 'On ... wrote:'", () => {
    const body = "Thanks, that works for me.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Bob <bob@x.com> wrote:\n> Can we meet Tuesday?\n> Bob";
    expect(latestMessageText(body)).toBe("Thanks, that works for me.");
  });

  it("drops '>' quoted lines, Original Message blocks, From: headers and signatures", () => {
    expect(latestMessageText("Sounds good.\n> old line\nSee you then.")).toBe("Sounds good.\nSee you then.");
    expect(latestMessageText("New text\r\n-----Original Message-----\r\nOld text")).toBe("New text");
    expect(latestMessageText("Reply here\nFrom: someone@x.com\nSent: Monday\nOld")).toBe("Reply here");
    expect(latestMessageText("Body line\n-- \nJane Doe\nCEO")).toBe("Body line");
  });

  it("does not let quoted history influence categorization", () => {
    const { result } = unwrap(
      processEmails({
        emails: [{ id: "1", from: "a@b.com", subject: "Thanks", body: "Great, thanks.\n\nOn Tue, X <x@y.com> wrote:\n> Your invoice is overdue", source: "pasted" }],
      }),
    );
    expect(result.emails[0].category).not.toBe("billing");
  });
});

// ---------------------------------------------------------------------------
// support.ts
// ---------------------------------------------------------------------------

describe("answerSupport", () => {
  const returnsDoc: KnowledgeChunk = {
    document_id: "doc-returns",
    title: "Returns policy",
    chunk_index: 0,
    content: "You can return unused items within 30 days of delivery for a full refund.",
    rank: 0.4,
  };
  const FABRICATED_STATUS = /(shipped|delivered|on its way|out for delivery|in transit|will arrive|dispatched)/i;

  it("escalates a request for a human", () => {
    const { result, ai_request } = unwrap(answerSupport({ message: "I want to talk to a real person please", knowledge: [returnsDoc] }));
    expect(result.intent).toBe("human_request");
    expect(result.escalate).toBe(true);
    expect(result.grounded).toBe(false);
    expect(ai_request).toBeNull();
    expect(result.needs_contact_details).toBe(true);
    expect(result.reply).toContain("name and email");
  });

  it("escalates order status without an order system and does not invent a status", () => {
    const { result, ai_request } = unwrap(
      answerSupport({ message: "Where is my order #4521?", knowledge: [returnsDoc], customer: { email: "c@x.com" }, integrations: { order_system: false } }),
    );
    expect(result.intent).toBe("order_status");
    expect(result.escalate).toBe(true);
    expect(result.escalation_reason).toMatch(/no order system/i);
    expect(result.reply).toMatch(/can't look up order details/i);
    expect(result.reply).not.toMatch(FABRICATED_STATUS);
    expect(result.reply).not.toContain("#4521");
    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.needs_contact_details).toBe(false); // email already known
    expect(ai_request).toBeNull();
  });

  it("escalates when no knowledge matches (or only below min_rank)", () => {
    const none = unwrap(answerSupport({ message: "Do you offer gift wrapping?", knowledge: [] })).result;
    expect(none.escalate).toBe(true);
    expect(none.grounded).toBe(false);
    expect(none.escalation_reason).toMatch(/no approved knowledge/i);
    const weak = unwrap(answerSupport({ message: "Do you offer gift wrapping?", knowledge: [{ ...returnsDoc, rank: 0.001 }] })).result;
    expect(weak.escalate).toBe(true);
  });

  it("answers from knowledge and cites the document", () => {
    const { result, ai_request } = unwrap(answerSupport({ message: "What is your return window?", knowledge: [returnsDoc], company_name: "Acme" }));
    expect(result.intent).toBe("refund");
    expect(result.escalate).toBe(false);
    expect(result.grounded).toBe(true);
    expect(result.citations).toEqual([{ document_id: "doc-returns", title: "Returns policy" }]);
    expect(result.reply).toContain('"Returns policy"');
    expect(result.reply).toContain("within 30 days");
    expect(ai_request).not.toBeNull();
    expect(ai_request!.prompt).toContain("within 30 days");
    expect(ai_request!.system).toContain("[ESCALATE]");
  });

  it("mergeSupportAi escalates when the model answers with [ESCALATE]", () => {
    const { result } = unwrap(answerSupport({ message: "What is your return window?", knowledge: [returnsDoc] }));
    const merged = mergeSupportAi(result, claudeText("Sorry, I'm not sure about that. [ESCALATE]"));
    expect(merged.escalate).toBe(true);
    expect(merged.escalation_reason).toMatch(/did not fully answer/i);
    expect(merged.reply).toBe("Sorry, I'm not sure about that.");
    expect(merged.reply).not.toContain("[ESCALATE]");
    expect(merged.ai_generated).toBe(true);
  });

  it("mergeSupportAi uses the AI reply when grounded and ignores it when not", () => {
    const grounded = unwrap(answerSupport({ message: "What is your return window?", knowledge: [returnsDoc] })).result;
    expect(mergeSupportAi(grounded, claudeText("You have 30 days to return unused items.")).reply).toBe("You have 30 days to return unused items.");
    const escalated = unwrap(answerSupport({ message: "talk to a human", knowledge: [] })).result;
    expect(mergeSupportAi(escalated, claudeText("Your order shipped yesterday."))).toBe(escalated);
  });
});

// ---------------------------------------------------------------------------
// advisory.ts
// ---------------------------------------------------------------------------

function metrics(overrides: { crm?: Partial<BusinessMetrics["crm"]>; deals?: Partial<BusinessMetrics["deals"]>; automation?: Partial<BusinessMetrics["automation"]> } = {}): BusinessMetrics {
  return {
    crm: { contacts_total: 0, by_status: {}, by_source: [], overdue_tasks: 0, open_tasks: 0, demo_records: 0, ...overrides.crm },
    deals: { open_count: 0, open_value: 0, won_count: 0, won_value: 0, lost_count: 0, by_stage: [], stale_count: 0, stale_value: 0, stale_days: 14, ...overrides.deals },
    analytics: null,
    finance: null,
    automation: { runs_30d: 0, failed_30d: 0, ...overrides.automation },
  };
}

describe("advise", () => {
  const rich = metrics({
    crm: { contacts_total: 40, by_status: { lead: 30, qualified: 5, customer: 2, unqualified: 3 }, overdue_tasks: 4 },
    deals: {
      open_count: 6,
      open_value: 10000,
      won_count: 1,
      lost_count: 5,
      by_stage: [
        { stage: "new", count: 3, value: 7000 },
        { stage: "proposal", count: 3, value: 3000 },
      ],
      stale_count: 2,
      stale_value: 4500,
      stale_days: 14,
    },
    automation: { runs_30d: 10, failed_30d: 1 },
  });

  it("recommends re-engaging stale deals with evidence", () => {
    const { result } = unwrap(advise({ question: "What should I focus on?", metrics: metrics({ crm: { contacts_total: 3 }, deals: { open_count: 2, open_value: 4500, stale_count: 2, stale_value: 4500 } }) }));
    const stale = result.recommendations.find((r) => r.key === "stale_deals");
    expect(stale).toBeDefined();
    expect(stale!.title).toBe("Re-engage 2 stalled deals");
    expect(stale!.evidence).toEqual([
      { metric: "Stalled open deals", value: "2", source: "CRM deals" },
      { metric: "Value of stalled deals", value: "USD 4,500", source: "CRM deals" },
    ]);
  });

  it('limits to 3 when asked for "three actions", highest priority first', () => {
    const all = unwrap(advise({ question: "How can I grow?", metrics: rich })).result.recommendations;
    expect(all.length).toBe(5);
    const { result } = unwrap(advise({ question: "Give me three actions to grow revenue", metrics: rich }));
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations.map((r) => r.key)).toEqual(all.slice(0, 3).map((r) => r.key));
    expect(result.recommendations.map((r) => r.key)).toEqual(["stale_deals", "lead_conversion", "win_rate"]);
    expect(unwrap(advise({ question: "List 2 recommendations", metrics: rich })).result.recommendations).toHaveLength(2);
  });

  it("every recommendation has at least one evidence item", () => {
    const { result } = unwrap(advise({ question: "What should I do?", metrics: rich }));
    expect(result.recommendations.length).toBeGreaterThan(0);
    for (const r of result.recommendations) {
      expect(r.evidence.length).toBeGreaterThanOrEqual(1);
      for (const e of r.evidence) {
        expect(e.metric).toBeTruthy();
        expect(e.value).toBeTruthy();
        expect(e.source).toBeTruthy();
      }
    }
  });

  it("flags insufficient data with an empty CRM and makes no AI request", () => {
    const { result, ai_request } = unwrap(advise({ question: "Give me three actions", metrics: metrics() }));
    expect(result.insufficient_data).toBe(true);
    expect(result.recommendations).toEqual([]);
    expect(result.missing_data).toEqual(["CRM contacts", "CRM deals", "Sales data (Data Analytics)", "Finance review"]);
    expect(result.narrative).toMatch(/isn't enough data/);
    expect(ai_request).toBeNull();
  });

  it("fails on an empty question or missing metrics", () => {
    expect(advise({ question: "  ", metrics: rich })).toMatchObject({ ok: false, error: { code: "EMPTY_QUESTION" } });
    expect(advise({ question: "Hi", metrics: {} as BusinessMetrics })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

// ---------------------------------------------------------------------------
// crm.ts
// ---------------------------------------------------------------------------

describe("planCrmEvent", () => {
  const contact = { id: "c1", name: "Asha Rao", email: "asha@acme.io", company: "Acme", status: "lead", consent_status: "unknown", source: "Website" };

  it("contact.created lead → follow-up task and an email draft", () => {
    const { result, ai_request } = unwrap(planCrmEvent({ event: "contact.created", contact, sender_name: "Gaj" }));
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toEqual({ type: "create_task", subject: "Follow up with Asha Rao", body: "New lead from Website.", due_in_days: 1, contact_id: "c1", deal_id: null });
    expect(result.actions[1]).toMatchObject({ type: "create_email_draft", contact_id: "c1", to: "asha@acme.io", subject: "Following up — Acme" });
    const draft = result.actions[1];
    if (draft.type !== "create_email_draft") throw new Error("expected draft");
    expect(draft.body).toContain("Hi Asha,");
    expect(draft.body).toContain("Gaj");
    expect(ai_request).not.toBeNull();
  });

  it("opted_out contact → task but no draft", () => {
    const { result, ai_request } = unwrap(planCrmEvent({ event: "contact.created", contact: { ...contact, consent_status: "opted_out" } }));
    expect(result.actions.map((a) => a.type)).toEqual(["create_task"]);
    expect(result.log.join(" ")).toMatch(/opted out/i);
    expect(ai_request).toBeNull();
  });

  it("deal won → onboarding task and contact marked customer", () => {
    const { result } = unwrap(
      planCrmEvent({
        event: "deal.stage_changed",
        contact,
        deal: { id: "d1", title: "Acme pilot", stage: "won", previous_stage: "negotiation", value: 5000, currency: "USD" },
      }),
    );
    expect(result.actions).toContainEqual({ type: "update_contact_status", contact_id: "c1", status: "customer" });
    expect(result.actions).toContainEqual(expect.objectContaining({ type: "create_task", subject: "Kick off onboarding for Acme pilot", deal_id: "d1" }));
  });

  it("deal won for an existing customer does not re-update the status", () => {
    const { result } = unwrap(
      planCrmEvent({ event: "deal.stage_changed", contact: { ...contact, status: "customer" }, deal: { id: "d1", title: "Upsell", stage: "won", value: 1, currency: "USD" } }),
    );
    expect(result.actions.some((a) => a.type === "update_contact_status")).toBe(false);
  });

  it("unknown event fails", () => {
    const out = planCrmEvent({ event: "contact.deleted" } as unknown as CrmEventInput);
    expect(out).toMatchObject({ ok: false, error: { code: "UNKNOWN_EVENT" } });
    expect(planCrmEvent({} as CrmEventInput)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});

// ---------------------------------------------------------------------------
// n8n-entry.ts
// ---------------------------------------------------------------------------

describe("n8n entry", () => {
  const entry = makeN8nEntry(analyzeDataset, mergeAnalyticsAi);
  const envelope = (over: Partial<WorkflowEnvelope> = {}): WorkflowEnvelope => ({
    execution_id: "11111111-1111-4111-8111-111111111111",
    agent: "data-analytics-agent",
    organization_id: "22222222-2222-4222-8222-222222222222",
    callback: { url: "https://app.example/api/n8n/callback/x", token: "tok" },
    ai: { enabled: true, model: "claude-opus-5-5", provider: "anthropic" },
    input: { dataset: { name: "d.csv", columns: ["Product", "Revenue"], rows: [{ Product: "A", Revenue: "10" }] } },
    ...over,
  });

  it("process rejects an envelope without callback details", () => {
    const { callback: _c, ...noCallback } = envelope();
    const p = entry.process(noCallback as WorkflowEnvelope);
    expect(p).toMatchObject({ ok: false, execution_id: envelope().execution_id, error: { code: "BAD_ENVELOPE" }, use_ai: false, ai_body: null });
    expect(entry.process(envelope({ callback: { url: "https://x", token: "" } })).error?.code).toBe("BAD_ENVELOPE");
    expect(entry.process({ ...envelope(), execution_id: 5 } as unknown as WorkflowEnvelope)).toMatchObject({ ok: false, execution_id: null });
  });

  it("use_ai is false when ai.enabled is false", () => {
    const p = entry.process(envelope({ ai: { enabled: false, model: "claude-opus-5-5", provider: "anthropic" } }));
    expect(p.ok).toBe(true);
    expect(p.use_ai).toBe(false);
    expect(p.ai_body).toBeNull();
    expect(p.ai_headers).toBeNull();
    expect(entry.finalize(p, null)).toMatchObject({ status: "succeeded", ai_status: "skipped" });
  });

  it("builds the Claude request with the configured model when AI is enabled", () => {
    const p = entry.process(envelope());
    expect(p.use_ai).toBe(true);
    expect(p.ai_url).toBe("https://api.anthropic.com/v1/messages");
    expect(p.ai_body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 2000, fallbacks: "default" });
    expect(p.ai_headers).toMatchObject({ "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" });
  });

  it("builds an OpenAI-style Groq request when provider is groq", () => {
    const p = entry.process(envelope({ ai: { enabled: true, model: "", provider: "groq" } }));
    expect(p.ai_url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(p.ai_body).toMatchObject({ model: "llama-3.3-70b-versatile", max_tokens: 2000 });
    expect((p.ai_body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(p.ai_headers).toEqual({ "content-type": "application/json" });
    const g = buildGroqRequest({ system: "sys", prompt: "hello", max_tokens: 5 }, "openai/gpt-oss-120b");
    expect(g.body).toEqual({ model: "openai/gpt-oss-120b", max_tokens: 5, messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] });
  });

  it("readClaudeText reads both Anthropic and chat-completions responses", () => {
    expect(readClaudeText({ content: [{ type: "text", text: " hi " }], stop_reason: "end_turn" })).toBe("hi");
    expect(readClaudeText({ content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" })).toBeNull();
    expect(readClaudeText({ choices: [{ message: { role: "assistant", content: " groq says " }, finish_reason: "stop" }] })).toBe("groq says");
    expect(readClaudeText({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] })).toBeNull();
    expect(readClaudeText({ choices: [] })).toBeNull();
    expect(readClaudeText({ error: { message: "invalid api key" } })).toBeNull();
  });

  it("buildClaudeRequest adds fallbacks + beta header only for supported models", () => {
    const ai = { system: "sys", prompt: "hello", max_tokens: 100 };
    const opus = buildClaudeRequest(ai, "claude-opus-5-5");
    expect(opus.body).toEqual({ model: "claude-opus-5-5", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hello" }], fallbacks: "default" });
    expect(opus.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");

    const haiku = buildClaudeRequest(ai, "claude-haiku-5-5");
    expect(haiku.body).not.toHaveProperty("fallbacks");
    expect(haiku.headers).not.toHaveProperty("anthropic-beta");
    expect(haiku.headers).toEqual({ "anthropic-version": "2023-06-01", "content-type": "application/json" });
  });

  it("finalize returns failed for a processing failure", () => {
    const p = entry.process(envelope({ input: { dataset: { name: "e", columns: ["a"], rows: [] } } }));
    expect(p.ok).toBe(false);
    expect(entry.finalize(p, null)).toEqual({ status: "failed", result: null, error: { code: "EMPTY_DATASET", message: expect.any(String) }, ai_status: "skipped" });
  });

  it("finalize reports ai_status unavailable when the AI response is an error object", () => {
    const p = entry.process(envelope());
    const out = entry.finalize(p, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(out.status).toBe("succeeded");
    expect(out.ai_status).toBe("unavailable");
    expect(out.result).toEqual(p.result);
  });

  it("finalize reports ai_status used for a valid response", () => {
    const p = entry.process(envelope());
    const out = entry.finalize(p, claudeText(JSON.stringify({ summary: "AI summary", insights: [] })));
    expect(out).toMatchObject({ status: "succeeded", ai_status: "used", result: { summary: "AI summary", ai_generated: true } });
  });

  it("turns a thrown error in the logic into PROCESSING_ERROR", () => {
    const boom = makeN8nEntry(() => {
      throw new Error("boom");
    }, (r: unknown) => r);
    expect(boom.process(envelope())).toMatchObject({ ok: false, error: { code: "PROCESSING_ERROR", message: "Processing failed: boom" } });
  });

  it("WORKFLOW_LOGIC has an entry for every agent", () => {
    expect(Object.keys(WORKFLOW_LOGIC).sort()).toEqual([
      "crm-automation-agent",
      "customer-support-agent",
      "data-advisory-agent",
      "data-analytics-agent",
      "email-automation-agent",
      "finance-audit-agent",
      "lead-generation-agent",
    ]);
  });
});

describe("regressions fixed after the first test pass", () => {
  it("does not treat the word 'agent' alone as a request for a human", async () => {
    const { classifySupport } = await import("@/lib/agents/logic/support");
    expect(classifySupport("Do you offer a travel agent discount?").intent).not.toBe("human_request");
    expect(classifySupport("Can I talk to a live agent please").intent).toBe("human_request");
  });

  it("re-adds the exact opt-out sentence when the AI draft drops it", async () => {
    const { scoreLeads, mergeLeadsAi, OPT_OUT_LINE } = await import("@/lib/agents/logic/leads");
    const out = scoreLeads({
      source: "csv",
      prospects: { name: "p.csv", columns: ["name", "email", "industry"], rows: [{ name: "Riya Bansal", email: "riya@example.com", industry: "gifting" }] },
      criteria: { industries: ["gifting"], min_score: 10 },
    });
    if (!out.ok) throw new Error("expected ok");
    const id = out.result.prospects[0].id;
    const ai = { content: [{ type: "text", text: JSON.stringify({ drafts: [{ id, subject: "Hi", body: "Hello. Mention unsubscribe vaguely." }] }) }], stop_reason: "end_turn" };
    const merged = mergeLeadsAi(out.result, ai);
    expect(merged.prospects[0].outreach_draft?.body).toContain(OPT_OUT_LINE);
  });
});
