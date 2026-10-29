/*
 * Client-safe CRM constants and types.
 *
 * src/lib/crm.ts imports "server-only", so its runtime values can't be used in
 * client components. The lists below mirror it, and the `satisfies` checks
 * fail to compile if the server lists ever change.
 */
import type {
  ACTIVITY_TYPES as SERVER_ACTIVITY_TYPES,
  CONTACT_STATUSES as SERVER_CONTACT_STATUSES,
  DEAL_STAGES as SERVER_DEAL_STAGES,
  Activity,
  Contact,
  Deal,
} from "@/lib/crm";

export type { Activity, Contact, Deal };

export const CONTACT_STATUSES = ["lead", "qualified", "customer", "unqualified", "churned"] as const satisfies typeof SERVER_CONTACT_STATUSES;
export const DEAL_STAGES = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"] as const satisfies typeof SERVER_DEAL_STAGES;
export const ACTIVITY_TYPES = ["note", "task", "call", "email", "meeting", "reminder"] as const satisfies typeof SERVER_ACTIVITY_TYPES;
export const CONSENT_STATUSES = ["unknown", "opted_in", "opted_out"] as const satisfies readonly Contact["consent_status"][];

export type ContactStatus = (typeof CONTACT_STATUSES)[number];
export type DealStage = (typeof DEAL_STAGES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

export const STATUS_META: Record<ContactStatus, { label: string; tone: Tone }> = {
  lead: { label: "Lead", tone: "neutral" },
  qualified: { label: "Qualified", tone: "primary" },
  customer: { label: "Customer", tone: "success" },
  unqualified: { label: "Unqualified", tone: "warning" },
  churned: { label: "Churned", tone: "danger" },
};

export const STAGE_META: Record<DealStage, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "neutral" },
  contacted: { label: "Contacted", tone: "neutral" },
  qualified: { label: "Qualified", tone: "primary" },
  proposal: { label: "Proposal", tone: "primary" },
  negotiation: { label: "Negotiation", tone: "warning" },
  won: { label: "Won", tone: "success" },
  lost: { label: "Lost", tone: "danger" },
};

export const CONSENT_META: Record<ConsentStatus, { label: string; tone: Tone }> = {
  unknown: { label: "Consent unknown", tone: "neutral" },
  opted_in: { label: "Opted in", tone: "success" },
  opted_out: { label: "Opted out", tone: "danger" },
};

export const ACTIVITY_LABELS: Record<ActivityType | "system", string> = {
  note: "Note",
  task: "Task",
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  reminder: "Reminder",
  system: "System",
};

export const DRAFT_PREFIX = "Draft (not sent):";

export type ContactListResponse = { total: number; contacts: Contact[]; sources: string[] };
export type OpenTask = Activity & { contact_name: string | null };

export function isContactStatus(v: unknown): v is ContactStatus {
  return typeof v === "string" && (CONTACT_STATUSES as readonly string[]).includes(v);
}

export function isDealStage(v: unknown): v is DealStage {
  return typeof v === "string" && (DEAL_STAGES as readonly string[]).includes(v);
}

export function isTaskType(type: string) {
  return type === "task" || type === "reminder";
}

/** "system" for automation-created records or unknown types, so the timeline can label them. */
export function activityKind(a: Pick<Activity, "type" | "execution_id">): ActivityType | "system" {
  if ((ACTIVITY_TYPES as readonly string[]).includes(a.type)) return a.type as ActivityType;
  return "system";
}

export function isDraft(a: Pick<Activity, "subject">) {
  return a.subject.startsWith(DRAFT_PREFIX);
}

export function displaySubject(a: Pick<Activity, "subject">) {
  return isDraft(a) ? a.subject.slice(DRAFT_PREFIX.length).trim() || "(no subject)" : a.subject;
}

/**
 * Full contact payload for PATCH requests. The server's partial schema applies
 * defaults to omitted fields (tags → [], consent_status → "unknown"), so every
 * update sends the complete record to avoid silently resetting them.
 */
export function contactPayload(c: Contact, overrides: Partial<Contact> = {}) {
  const m = { ...c, ...overrides };
  return {
    name: m.name,
    email: m.email ?? null,
    phone: m.phone ?? null,
    company: m.company ?? null,
    source: m.source ?? null,
    status: m.status,
    consent_status: m.consent_status,
    tags: m.tags ?? [],
    industry: m.industry ?? null,
    location: m.location ?? null,
    company_size: m.company_size ?? null,
  };
}
