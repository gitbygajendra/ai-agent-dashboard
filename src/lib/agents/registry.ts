/**
 * Agent catalog. Safe to import from client components: contains no secrets.
 */
export const AGENT_SLUGS = [
  "data-analytics-agent",
  "email-automation-agent",
  "finance-audit-agent",
  "crm-automation-agent",
  "data-advisory-agent",
  "customer-support-agent",
  "lead-generation-agent",
] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

export type IntegrationProvider = "n8n" | "llm" | "gmail" | "lead_provider" | "order_system";

/** How complete the implementation is in this codebase. */
export type ImplementationLevel = "implemented" | "partial" | "awaiting_integration";

export type AgentDefinition = {
  slug: AgentSlug;
  name: string;
  description: string;
  icon: "BarChart3" | "Mail" | "Calculator" | "Users" | "Lightbulb" | "MessagesSquare" | "Target";
  implementation: ImplementationLevel;
  implementationNote: string;
  requires: IntegrationProvider[];
  optional: IntegrationProvider[];
  webhookEnv: string;
  example: string;
  capabilities: string[];
  manualRun: boolean;
};

export const AGENTS: Record<AgentSlug, AgentDefinition> = {
  "data-analytics-agent": {
    slug: "data-analytics-agent",
    name: "Data Analytics Agent",
    description: "Upload sales or performance data and get KPIs, charts, anomalies and a plain-language summary.",
    icon: "BarChart3",
    implementation: "implemented",
    implementationNote: "End to end: upload → n8n analysis → AI summary (optional) → saved results.",
    requires: ["n8n"],
    optional: ["llm"],
    webhookEnv: "N8N_WEBHOOK_URL_DATA_ANALYTICS",
    example: "Which products generated the highest revenue this month?",
    capabilities: ["CSV and Excel upload", "KPIs and trend charts", "Top products and categories", "Anomaly detection", "Natural-language questions", "Downloadable report"],
    manualRun: true,
  },
  "email-automation-agent": {
    slug: "email-automation-agent",
    name: "Email Automation Agent",
    description: "Categorize emails, summarize threads, extract action items and prepare replies for your approval.",
    icon: "Mail",
    implementation: "partial",
    implementationNote: "Pasted emails work now. Inbox processing and sending need Gmail connected (OAuth credentials).",
    requires: ["n8n"],
    optional: ["gmail", "llm"],
    webhookEnv: "N8N_WEBHOOK_URL_EMAIL_AUTOMATION",
    example: "Find unanswered customer emails and prepare replies for my approval.",
    capabilities: ["Categorize and prioritize", "Summaries and action items", "Draft replies", "Approval before sending", "Follow-up reminders"],
    manualRun: true,
  },
  "finance-audit-agent": {
    slug: "finance-audit-agent",
    name: "Finance Audit Agent",
    description: "Reconcile invoices against transactions and flag duplicates, missing payments and unusual expenses.",
    icon: "Calculator",
    implementation: "implemented",
    implementationNote: "File-based reconciliation with traceable findings. Not a formal audit.",
    requires: ["n8n"],
    optional: ["llm"],
    webhookEnv: "N8N_WEBHOOK_URL_FINANCE_AUDIT",
    example: "Compare these invoices with my transaction sheet and identify missing payments or duplicate entries.",
    capabilities: ["Income and expense categorization", "Duplicate detection", "Invoice reconciliation", "Unusual expense flags", "Monthly summary", "Exportable findings"],
    manualRun: true,
  },
  "crm-automation-agent": {
    slug: "crm-automation-agent",
    name: "CRM Automation",
    description: "Runs automatically when leads and deals change: creates follow-up tasks, updates records and drafts emails.",
    icon: "Users",
    implementation: "implemented",
    implementationNote: "Triggered by CRM events (new lead, status change, deal stage change).",
    requires: ["n8n"],
    optional: ["llm"],
    webhookEnv: "N8N_WEBHOOK_URL_CRM_AUTOMATION",
    example: "A new lead is added, gets a follow-up task and an intro email draft.",
    capabilities: ["Contacts, deals and pipeline", "Follow-up tasks", "Stage-based automations", "Email drafts for review", "CSV import and export"],
    manualRun: false,
  },
  "data-advisory-agent": {
    slug: "data-advisory-agent",
    name: "Data-Driven Advisory Agent",
    description: "Ask about your business and get recommendations backed by the figures in your own records.",
    icon: "Lightbulb",
    implementation: "implemented",
    implementationNote: "Uses CRM, analytics and finance records. Recommendations cite their evidence.",
    requires: ["n8n"],
    optional: ["llm"],
    webhookEnv: "N8N_WEBHOOK_URL_DATA_ADVISORY",
    example: "My sales are declining. Recommend three actions to improve conversions.",
    capabilities: ["Evidence-backed recommendations", "Verified metrics vs assumptions", "Confidence and risks", "Track recommendation status", "Follow-up questions"],
    manualRun: true,
  },
  "customer-support-agent": {
    slug: "customer-support-agent",
    name: "Customer Support Chatbot",
    description: "Answers customer questions from your approved knowledge base and escalates what it can't answer.",
    icon: "MessagesSquare",
    implementation: "partial",
    implementationNote: "Knowledge-base answers, ticketing and escalation work. Order lookups need an order system; website widget not built yet.",
    requires: ["n8n"],
    optional: ["llm", "order_system"],
    webhookEnv: "N8N_WEBHOOK_URL_CUSTOMER_SUPPORT",
    example: "What is your return policy?",
    capabilities: ["Grounded answers with sources", "Intent and urgency classification", "Escalation and tickets", "Conversation history", "Knowledge base uploads"],
    manualRun: true,
  },
  "lead-generation-agent": {
    slug: "lead-generation-agent",
    name: "Lead Generation Agent",
    description: "Score and segment prospect lists, draft personalized outreach and push approved leads into the CRM.",
    icon: "Target",
    implementation: "partial",
    implementationNote: "CSV prospect lists work now. Live prospect search needs an authorized data provider.",
    requires: ["n8n"],
    optional: ["lead_provider", "llm"],
    webhookEnv: "N8N_WEBHOOK_URL_LEAD_GENERATION",
    example: "Score these corporate gifting businesses in Delhi NCR and add qualified ones to the CRM.",
    capabilities: ["Ideal customer profile", "CSV import", "Scoring and segmentation", "Deduplication", "Outreach drafts", "Push to CRM after review"],
    manualRun: true,
  },
};

export function isAgentSlug(value: string): value is AgentSlug {
  return (AGENT_SLUGS as readonly string[]).includes(value);
}

export const INTEGRATIONS: Record<IntegrationProvider, { name: string; description: string; setup: string }> = {
  n8n: {
    name: "Workflow engine",
    description: "Runs every agent's pipeline: built into the app by default, or n8n.",
    setup: "Nothing to do for the built-in engine. To use n8n instead: set N8N_BASE_URL and N8N_WEBHOOK_SECRET, then import and publish n8n/agent-dashboard-master.json.",
  },
  llm: {
    name: "AI model (Anthropic Claude or Groq)",
    description: "Writes summaries, answers and drafts. Agents still return computed results without it.",
    setup: "Add GROQ_API_KEY=... (free at console.groq.com/keys) or ANTHROPIC_API_KEY=... to .env.local and restart. With n8n, give the key to n8n instead (see n8n/README.md).",
  },
  gmail: {
    name: "Gmail",
    description: "Read recent inbox emails and send approved replies.",
    setup: "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ENCRYPTION_KEY, then click Connect.",
  },
  lead_provider: {
    name: "Lead data provider",
    description: "Authorized B2B data source for live prospect search.",
    setup: "Not connected. Import prospect CSVs, or add a provider integration (e.g. Apollo, Clearbit) with its API terms.",
  },
  order_system: {
    name: "Order system",
    description: "Lets the support chatbot look up order status.",
    setup: "Not connected. Connect Shopify/WooCommerce or your order API through an n8n sub-workflow.",
  },
};
