import {
  type AiRequest,
  type LogicOutput,
  type Row,
  type Stage,
  extractJson,
  fail,
  findColumn,
  GROUNDING_RULES,
  pipelineOutput,
  readClaudeText,
  runStages,
  truncate,
} from "./common";

export type LeadCriteria = {
  industries?: string[];
  locations?: string[];
  company_sizes?: string[];
  keywords?: string[];
  min_score?: number;
};

export type LeadInput = {
  source: "csv" | "provider";
  prospects?: { name: string; columns: string[]; rows: Row[] } | null;
  criteria?: LeadCriteria;
  existing_emails?: string[];
  sender?: { name?: string; company?: string; offering?: string };
};

export type Prospect = {
  id: string;
  row: number;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  industry: string | null;
  location: string | null;
  company_size: string | null;
  score: number;
  qualified: boolean;
  reasons: string[];
  status: "new" | "duplicate_in_crm" | "duplicate_in_file" | "opted_out";
  outreach_draft: { subject: string; body: string } | null;
};

export type LeadResult = {
  source: string;
  total_rows: number;
  prospects: Prospect[];
  qualified_count: number;
  excluded: { duplicate_in_crm: number; duplicate_in_file: number; opted_out: number; invalid: number };
  segments: { by_industry: { name: string; count: number }[]; by_location: { name: string; count: number }[]; by_size: { name: string; count: number }[] };
  criteria: Required<LeadCriteria>;
  compliance_note: string;
  ai_generated: boolean;
};

export const OPT_OUT_LINE = "If you'd prefer not to hear from us, reply \"unsubscribe\" and we won't contact you again.";

const DECISION_MAKER = /(founder|co-founder|ceo|owner|director|head|vp|vice president|partner|manager|chief|proprietor)/i;

function cell(r: Row, col: string | null): string | null {
  if (!col) return null;
  const v = String(r[col] ?? "").trim();
  return v || null;
}

function matchesAny(value: string | null, terms: string[]): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  return terms.find((t) => t && v.includes(t.toLowerCase())) ?? null;
}

function countBy(items: Prospect[], key: (p: Prospect) => string | null) {
  const m = new Map<string, number>();
  for (const p of items) {
    const k = key(p) || "Unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
}

// Prospect plus the row facts later stages still need; stripped before output.
type Parsed = Prospect & { first: string | null; notes: string | null; opted_out: boolean; dedupe_key: string };

export type LeadState = {
  input: LeadInput;
  criteria?: Required<LeadCriteria>;
  parsed?: Parsed[];
  invalid?: number;
  excluded?: LeadResult["excluded"];
  output?: LogicOutput<LeadResult>;
};

export const LEAD_STAGES: Stage<LeadState>[] = [
  {
    name: "parse prospects",
    run(s) {
      const input = s.input;
      if (input?.source === "provider" && !input.prospects) {
        return { ...s, output: fail("PROVIDER_NOT_CONNECTED", "No lead data provider is connected. Import a CSV of prospects or connect a provider on the Integrations page.") };
      }
      const table = input?.prospects;
      if (!table || !Array.isArray(table.rows) || !Array.isArray(table.columns)) return { ...s, output: fail("INVALID_INPUT", "A prospect list is required.") };
      if (!table.rows.length) return { ...s, output: fail("EMPTY_DATASET", "The prospect file has no rows.") };

      const criteria: Required<LeadCriteria> = {
        industries: (input.criteria?.industries ?? []).filter(Boolean),
        locations: (input.criteria?.locations ?? []).filter(Boolean),
        company_sizes: (input.criteria?.company_sizes ?? []).filter(Boolean),
        keywords: (input.criteria?.keywords ?? []).filter(Boolean),
        min_score: input.criteria?.min_score ?? 60,
      };
      const cols = table.columns;
      const c = {
        name: findColumn(cols, [/^(contact_)?name$/, /full_name/, /contact/, /person/]),
        first: findColumn(cols, [/first_name/, /^first$/]),
        last: findColumn(cols, [/last_name/, /^last$/, /surname/]),
        email: findColumn(cols, [/^e?mail$/, /email/]),
        phone: findColumn(cols, [/phone/, /mobile/, /tel/]),
        title: findColumn(cols, [/title/, /designation/, /role/, /position/]),
        company: findColumn(cols, [/^company$/, /company_name/, /organization/, /organisation/, /business/, /account/]),
        website: findColumn(cols, [/website/, /domain/, /url/, /site/]),
        industry: findColumn(cols, [/industry/, /sector/, /category/, /vertical/]),
        location: findColumn(cols, [/location/, /city/, /region/, /state/, /area/, /address/]),
        size: findColumn(cols, [/company_size/, /size/, /employees/, /headcount/, /staff/]),
        consent: findColumn(cols, [/consent/, /opt_?in/, /unsubscribed/, /opt_?out/, /do_not_contact/]),
        notes: findColumn(cols, [/notes?/, /description/, /about/, /keywords?/, /tags?/]),
      };
      if (!c.email && !c.company && !c.name && !c.first) {
        return { ...s, output: fail("NO_IDENTITY_COLUMNS", "The prospect file needs at least a name, company or email column.") };
      }
      let invalid = 0;
      const parsed: Parsed[] = [];
      table.rows.forEach((r, i) => {
        const first = cell(r, c.first);
        const last = cell(r, c.last);
        const name = cell(r, c.name) ?? ([first, last].filter(Boolean).join(" ") || null);
        const company = cell(r, c.company);
        const rawEmail = cell(r, c.email);
        const email = rawEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail.toLowerCase() : null;
        if (!name && !company && !email) {
          invalid++;
          return;
        }
        const consentRaw = (cell(r, c.consent) ?? "").toLowerCase();
        const consentHeader = c.consent ? c.consent.toLowerCase() : "";
        const optedOut =
          (/unsub|opt_?out|do_not_contact/.test(consentHeader) && /^(true|yes|y|1)$/.test(consentRaw)) ||
          (/consent|opt_?in/.test(consentHeader) && /^(false|no|n|0|withdrawn)$/.test(consentRaw));
        parsed.push({
          id: `P-${String(i + 1).padStart(4, "0")}`,
          row: i + 2,
          name: name ?? company ?? email ?? "Unknown",
          email,
          phone: cell(r, c.phone),
          title: cell(r, c.title),
          company,
          website: cell(r, c.website),
          industry: cell(r, c.industry),
          location: cell(r, c.location),
          company_size: cell(r, c.size),
          score: 0,
          qualified: false,
          reasons: [],
          status: "new",
          outreach_draft: null,
          first,
          notes: cell(r, c.notes),
          opted_out: optedOut,
          dedupe_key: email ?? `${(company ?? "").toLowerCase()}|${(name ?? "").toLowerCase()}`,
        });
      });
      return { ...s, criteria, parsed, invalid };
    },
  },
  {
    name: "remove duplicates",
    run(s) {
      const existing = new Set((s.input.existing_emails ?? []).map((e) => e.toLowerCase()));
      const seen = new Set<string>();
      const parsed = s.parsed!.map((p) => {
        let status: Prospect["status"] = "new";
        if (p.email && existing.has(p.email)) status = "duplicate_in_crm";
        else if (seen.has(p.dedupe_key)) status = "duplicate_in_file";
        seen.add(p.dedupe_key);
        return { ...p, status };
      });
      return { ...s, parsed };
    },
  },
  {
    name: "exclude opt-outs",
    run(s) {
      // Opt-out wins over the duplicate statuses, as in the original row-by-row check.
      const parsed = s.parsed!.map((p) => (p.opted_out ? { ...p, status: "opted_out" as const } : p));
      const excluded = { duplicate_in_crm: 0, duplicate_in_file: 0, opted_out: 0, invalid: s.invalid! };
      for (const p of parsed) if (p.status !== "new") excluded[p.status]++;
      return { ...s, parsed, excluded };
    },
  },
  {
    name: "score leads",
    run(s) {
      const criteria = s.criteria!;
      const noCriteria = !criteria.industries.length && !criteria.locations.length && !criteria.company_sizes.length && !criteria.keywords.length;
      const parsed = s.parsed!.map((p) => {
        const reasons: string[] = [];
        let score = 0;
        const ind = criteria.industries.length ? matchesAny(`${p.industry ?? ""} ${p.company ?? ""} ${p.notes ?? ""}`, criteria.industries) : null;
        if (ind) { score += 30; reasons.push(`Industry matches "${ind}"`); }
        const loc = criteria.locations.length ? matchesAny(p.location, criteria.locations) : null;
        if (loc) { score += 25; reasons.push(`Location matches "${loc}"`); }
        const sz = criteria.company_sizes.length ? matchesAny(p.company_size, criteria.company_sizes) : null;
        if (sz) { score += 15; reasons.push(`Company size matches "${sz}"`); }
        const kw = criteria.keywords.length ? matchesAny(`${p.company ?? ""} ${p.industry ?? ""} ${p.title ?? ""} ${p.notes ?? ""}`, criteria.keywords) : null;
        if (kw) { score += 15; reasons.push(`Keyword "${kw}" found`); }
        if (p.email) { score += 10; reasons.push("Has a valid email"); }
        if (p.title && DECISION_MAKER.test(p.title)) { score += 5; reasons.push("Decision-maker title"); }
        // With no criteria at all, score on contactability only so results stay meaningful.
        if (noCriteria) score = Math.min(100, score * 3 + (p.company ? 20 : 0) + (p.phone ? 10 : 0));
        score = Math.min(100, score);
        return { ...p, score, reasons, qualified: p.status === "new" && score >= criteria.min_score };
      });
      return { ...s, parsed };
    },
  },
  {
    name: "segment",
    run(s) {
      const parsed = [...s.parsed!].sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score);
      return { ...s, parsed };
    },
  },
  {
    name: "draft outreach",
    run(s) {
      const sender = s.input.sender ?? {};
      const prospects: Prospect[] = s.parsed!.map((row) => {
        const { first, notes, opted_out, dedupe_key, ...p } = row;
        void notes; void opted_out; void dedupe_key; // stripped from the output
        const greetingName = (first ?? p.name ?? "there").split(" ")[0];
        return {
          ...p,
          outreach_draft: p.qualified && p.email
            ? {
                subject: truncate(`${sender.company ? `${sender.company} × ` : ""}${p.company ?? greetingName}`, 120),
                body: [
                  `Hi ${greetingName},`,
                  "",
                  `I came across ${p.company ?? "your business"}${p.location ? ` in ${p.location}` : ""}${p.industry ? ` and your work in ${p.industry.toLowerCase()}` : ""}.`,
                  sender.offering ? `We help businesses like yours with ${sender.offering}.` : "[Describe how you can help in one sentence.]",
                  "Would you be open to a short call next week to see if it's a fit?",
                  "",
                  `Best,`,
                  sender.name ?? "[Your name]",
                  "",
                  OPT_OUT_LINE,
                ].join("\n"),
              }
            : null,
        };
      });
      const active = prospects.filter((p) => p.status === "new");
      const result: LeadResult = {
        source: s.input.source,
        total_rows: s.input.prospects!.rows.length,
        prospects,
        qualified_count: prospects.filter((p) => p.qualified).length,
        excluded: s.excluded!,
        segments: {
          by_industry: countBy(active, (p) => p.industry),
          by_location: countBy(active, (p) => p.location),
          by_size: countBy(active, (p) => p.company_size),
        },
        criteria: s.criteria!,
        compliance_note:
          "Only contact people with a lawful basis (consent or legitimate interest under laws such as GDPR, CAN-SPAM or India's DPDP Act). Opted-out records are excluded and every draft includes an unsubscribe line. Nothing is sent until you approve it.",
        ai_generated: false,
      };
      return { ...s, output: { ok: true, result, ai_request: buildAiRequest(result, sender) } };
    },
  },
];

export function scoreLeads(input: LeadInput): LogicOutput<LeadResult> {
  return pipelineOutput(runStages(LEAD_STAGES, { input }));
}

function buildAiRequest(result: LeadResult, sender: NonNullable<LeadInput["sender"]>): AiRequest | null {
  const top = result.prospects.filter((p) => p.outreach_draft).slice(0, 10);
  if (!top.length) return null;
  return {
    system: [
      "You write short, respectful B2B outreach emails.",
      GROUNDING_RULES,
      "Personalize only with the fields provided for each prospect. Do not claim familiarity, mutual contacts or facts that are not in the data.",
      "Keep each email under 120 words and keep the unsubscribe sentence exactly as given.",
      'Respond with JSON: {"drafts": [{"id": string, "subject": string, "body": string}]}.',
    ].join("\n"),
    prompt: `Sender: ${JSON.stringify(sender)}\nProspects and template drafts:\n${JSON.stringify(top.map((p) => ({ id: p.id, name: p.name, title: p.title, company: p.company, industry: p.industry, location: p.location, draft: p.outreach_draft })))}`,
    max_tokens: 4000,
  };
}

export function mergeLeadsAi(result: LeadResult, aiResponse: unknown): LeadResult {
  const text = readClaudeText(aiResponse);
  const parsed = text ? (extractJson(text) as { drafts?: { id?: unknown; subject?: unknown; body?: unknown }[] } | null) : null;
  if (!parsed || !Array.isArray(parsed.drafts)) return result;
  const byId = new Map(parsed.drafts.filter((d) => typeof d.id === "string").map((d) => [d.id as string, d]));
  return {
    ...result,
    ai_generated: true,
    prospects: result.prospects.map((p) => {
      const d = byId.get(p.id);
      if (!p.outreach_draft || !d || typeof d.subject !== "string" || typeof d.body !== "string") return p;
      const body = d.body.includes(OPT_OUT_LINE) ? d.body : `${d.body.trimEnd()}\n\n${OPT_OUT_LINE}`;
      return { ...p, outreach_draft: { subject: d.subject.slice(0, 150), body: body.slice(0, 4000) } };
    }),
  };
}
