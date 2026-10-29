import { type AiRequest, type LogicOutput, type Stage, extractJson, fail, GROUNDING_RULES, pipelineOutput, readClaudeText, runStages, truncate } from "./common";

export type EmailMessage = {
  id: string;
  thread_id?: string | null;
  from: string;
  to?: string | null;
  subject: string;
  date?: string | null;
  body: string;
  source: "gmail" | "pasted";
};

export type EmailInput = {
  emails: EmailMessage[];
  instructions?: string | null;
  sender_name?: string | null;
  tone?: "friendly" | "formal" | "concise";
};

export type EmailCategory =
  | "customer_inquiry"
  | "support"
  | "sales_lead"
  | "billing"
  | "scheduling"
  | "newsletter"
  | "internal"
  | "other";

export type ProcessedEmail = {
  id: string;
  thread_id: string | null;
  source: "gmail" | "pasted";
  from: string;
  from_name: string | null;
  from_email: string | null;
  subject: string;
  category: EmailCategory;
  priority: "high" | "normal" | "low";
  needs_reply: boolean;
  summary: string;
  action_items: string[];
  entities: { dates: string[]; amounts: string[]; emails: string[]; phones: string[]; names: string[] };
  follow_up: { reason: string; due_hint: string | null } | null;
  draft: { to: string | null; subject: string; body: string } | null;
};

export type EmailResult = {
  emails: ProcessedEmail[];
  counts: { total: number; needs_reply: number; drafts: number; by_category: Record<string, number> };
  emails_processed: number;
  approval_required: true;
  ai_generated: boolean;
};

const CATEGORY_RULES: [EmailCategory, RegExp][] = [
  ["newsletter", /(unsubscribe|view in browser|newsletter|no-?reply|marketing preferences)/i],
  ["billing", /(invoice|payment|refund|charge|billing|receipt|overdue|bank transfer)/i],
  ["support", /(not working|error|issue|problem|bug|broken|can't log ?in|cannot|help with|complaint)/i],
  ["scheduling", /(meeting|schedule|reschedule|calendar|call on|availability|appointment|book a (call|demo))/i],
  ["sales_lead", /(pricing|quote|quotation|proposal|interested in|demo|bulk order|partnership|catalog)/i],
  ["customer_inquiry", /(\?|could you|can you|would like to know|enquir|inquir|question)/i],
];

const DATE_RE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|today|next week|end of (?:day|week|month)|eod|eow|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?)\b/gi;
const AMOUNT_RE = /(?:[$€£₹]|rs\.?|inr|usd|eur)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:usd|inr|eur|rupees|dollars)/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s-]{8,}\d)/g;

function parseFrom(from: string): { name: string | null; email: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  const e = from.match(EMAIL_RE);
  return { name: null, email: e ? e[0].toLowerCase() : null };
}

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
}

/** Drop quoted history and signatures so only the newest message is analyzed. */
export function latestMessageText(body: string): string {
  const lines = body.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From: /.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    if (/^--\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function uniq(list: string[] | null | undefined, max = 10): string[] {
  return [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, max);
}

type ParsedEmail = {
  id: string;
  thread_id: string | null;
  source: "gmail" | "pasted";
  from: string;
  from_name: string | null;
  from_email: string | null;
  subject: string;
  text: string;
  haystack: string;
};

type ExtractedEmail = Omit<ProcessedEmail, "draft"> & { sentences_sample: string[] };

export type EmailState = {
  input: EmailInput;
  signer?: string;
  parsed?: ParsedEmail[];
  categories?: EmailCategory[];
  extracted?: ExtractedEmail[];
  output?: LogicOutput<EmailResult>;
};

/** Stages must only pass JSON-safe data between them (they become separate n8n Code nodes). */
export const EMAIL_STAGES: Stage<EmailState>[] = [
  {
    name: "parse emails",
    run(s) {
      const input = s.input;
      if (!input || !Array.isArray(input.emails)) return { ...s, output: fail("INVALID_INPUT", "No emails were provided.") };
      if (!input.emails.length) return { ...s, output: fail("NO_EMAILS", "No emails matched. Nothing to process.") };
      const signer = input.sender_name?.trim() || "[Your name]";
      const parsed: ParsedEmail[] = input.emails.slice(0, 50).map((e) => {
        const text = latestMessageText(String(e.body ?? "")).slice(0, 8000);
        const subject = String(e.subject ?? "").trim() || "(no subject)";
        const from = parseFrom(String(e.from ?? ""));
        return {
          id: String(e.id),
          thread_id: e.thread_id ?? null,
          source: e.source === "gmail" ? "gmail" : "pasted",
          from: String(e.from ?? ""),
          from_name: from.name,
          from_email: from.email,
          subject,
          text,
          haystack: `${subject}\n${text}`,
        };
      });
      return { ...s, signer, parsed };
    },
  },
  {
    name: "classify emails",
    run(s) {
      const categories = s.parsed!.map((p) => {
        let category: EmailCategory = "other";
        for (const [cat, re] of CATEGORY_RULES) {
          if (re.test(p.haystack) || (cat === "newsletter" && re.test(p.from))) {
            category = cat;
            break;
          }
        }
        return category;
      });
      return { ...s, categories };
    },
  },
  {
    name: "extract actions, entities and priority",
    run(s) {
      const extracted: ExtractedEmail[] = s.parsed!.map((p, i) => {
        const category = s.categories![i];
        const sents = sentences(p.text);
        const actionItems = sents
          .filter((x) => /(please|could you|can you|kindly|need you to|would you|let me know|send (me|us)|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|end|eod|\d))/i.test(x))
          .map((x) => truncate(x, 200))
          .slice(0, 6);
        const isNewsletter = category === "newsletter";
        const needsReply = !isNewsletter && (actionItems.length > 0 || /\?/.test(p.text) || ["support", "sales_lead", "billing", "customer_inquiry", "scheduling"].includes(category));
        const urgent = /(urgent|asap|immediately|as soon as possible|overdue|final notice|legal)/i.test(p.haystack);
        const priority: ProcessedEmail["priority"] = urgent ? "high" : isNewsletter ? "low" : needsReply ? "normal" : "low";
        const dates = uniq(p.haystack.match(DATE_RE));
        return {
          id: p.id,
          thread_id: p.thread_id,
          source: p.source,
          from: p.from,
          from_name: p.from_name,
          from_email: p.from_email,
          subject: p.subject,
          category,
          priority,
          needs_reply: needsReply,
          summary: truncate(sents.slice(0, 2).join(" ") || p.subject, 300),
          action_items: actionItems,
          entities: {
            dates,
            amounts: uniq(p.haystack.match(AMOUNT_RE)),
            emails: uniq(p.text.match(EMAIL_RE)),
            phones: uniq(p.text.match(PHONE_RE)?.filter((ph) => ph.replace(/\D/g, "").length >= 10)),
            names: p.from_name ? [p.from_name] : [],
          },
          follow_up: needsReply ? { reason: actionItems[0] ?? `Reply to "${truncate(p.subject, 60)}"`, due_hint: dates[0] ?? null } : null,
          sentences_sample: sents.slice(0, 2),
        };
      });
      return { ...s, extracted };
    },
  },
  {
    name: "draft replies",
    run(s) {
      const signer = s.signer!;
      const processed: ProcessedEmail[] = s.extracted!.map((x) => {
        const rest = { ...x, sentences_sample: undefined };
        delete rest.sentences_sample;
        const greeting = x.from_name ? x.from_name.split(" ")[0] : "there";
        const replyLines = [
          `Hi ${greeting},`,
          "",
          `Thanks for your email about "${truncate(x.subject.replace(/^(re|fwd?):\s*/i, ""), 80)}".`,
          ...(x.action_items.length
            ? ["", "To make sure I've got everything:", ...x.action_items.slice(0, 3).map((a) => `• ${a}`), "", "[Add your answer to each point here.]"]
            : ["", "[Add your reply here.]"]),
          "",
          "Best regards,",
          signer,
        ];
        return {
          ...rest,
          draft: x.needs_reply
            ? { to: x.from_email, subject: /^re:/i.test(x.subject) ? x.subject : `Re: ${x.subject}`, body: replyLines.join("\n") }
            : null,
        };
      });
      const byCategory: Record<string, number> = {};
      for (const p of processed) byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
      const result: EmailResult = {
        emails: processed,
        counts: {
          total: processed.length,
          needs_reply: processed.filter((p) => p.needs_reply).length,
          drafts: processed.filter((p) => p.draft).length,
          by_category: byCategory,
        },
        emails_processed: processed.length,
        approval_required: true,
        ai_generated: false,
      };
      return { ...s, output: { ok: true, result, ai_request: buildAiRequest(s.input, processed) } };
    },
  },
];

export function processEmails(input: EmailInput): LogicOutput<EmailResult> {
  return pipelineOutput(runStages(EMAIL_STAGES, { input }));
}

function buildAiRequest(input: EmailInput, processed: ProcessedEmail[]): AiRequest | null {
  const needing = processed.filter((p) => p.draft).slice(0, 15);
  if (!needing.length) return null;
  const originals = new Map(input.emails.map((e) => [String(e.id), latestMessageText(String(e.body ?? "")).slice(0, 3000)]));
  return {
    system: [
      "You draft email replies for a business owner. The owner reviews every draft before anything is sent.",
      GROUNDING_RULES,
      "Never promise refunds, prices, dates or policies that are not stated in the email or the owner's instructions. Use [placeholders] for anything the owner must fill in.",
      `Tone: ${input.tone ?? "friendly"}. Sign as: ${input.sender_name || "[Your name]"}.`,
      'Respond with JSON: {"emails": [{"id": string, "summary": string, "action_items": string[], "draft_body": string}]}.',
    ].join("\n"),
    prompt: `Owner instructions: ${input.instructions || "(none)"}\n\nEmails:\n${JSON.stringify(needing.map((p) => ({ id: p.id, from: p.from, subject: p.subject, category: p.category, body: originals.get(p.id) })))}`,
    max_tokens: 6000,
  };
}

export function mergeEmailAi(result: EmailResult, aiResponse: unknown): EmailResult {
  const text = readClaudeText(aiResponse);
  const parsed = text ? (extractJson(text) as { emails?: { id?: unknown; summary?: unknown; action_items?: unknown; draft_body?: unknown }[] } | null) : null;
  if (!parsed || !Array.isArray(parsed.emails)) return result;
  const byId = new Map(parsed.emails.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
  return {
    ...result,
    ai_generated: true,
    emails: result.emails.map((e) => {
      const ai = byId.get(e.id);
      if (!ai) return e;
      return {
        ...e,
        summary: typeof ai.summary === "string" ? truncate(ai.summary, 500) : e.summary,
        action_items: Array.isArray(ai.action_items) ? ai.action_items.filter((a): a is string => typeof a === "string").slice(0, 8) : e.action_items,
        draft: e.draft && typeof ai.draft_body === "string" ? { ...e.draft, body: ai.draft_body.slice(0, 8000) } : e.draft,
      };
    }),
  };
}
