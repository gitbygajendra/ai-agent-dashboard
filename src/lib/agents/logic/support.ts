import { type AiRequest, type LogicOutput, type Stage, fail, pipelineOutput, readClaudeText, runStages, truncate } from "./common";

export type KnowledgeChunk = { document_id: string; title: string; chunk_index: number; content: string; rank: number };

export type SupportInput = {
  message: string;
  history?: { role: "customer" | "assistant"; content: string }[];
  customer?: { name?: string | null; email?: string | null };
  knowledge: KnowledgeChunk[];
  integrations?: { order_system?: boolean };
  company_name?: string;
  min_rank?: number;
};

export type SupportIntent =
  | "order_status"
  | "refund"
  | "billing"
  | "technical"
  | "account"
  | "pricing"
  | "complaint"
  | "human_request"
  | "general";

export type SupportResult = {
  reply: string;
  intent: SupportIntent;
  urgency: "low" | "normal" | "high" | "urgent";
  escalate: boolean;
  escalation_reason: string | null;
  grounded: boolean;
  citations: { document_id: string; title: string }[];
  needs_contact_details: boolean;
  ai_generated: boolean;
};

const INTENTS: [SupportIntent, RegExp][] = [
  ["human_request", /\b(human|real person|(live|human|support|real) agent|representative|talk to (someone|a person|an agent)|speak to (someone|a person|an agent)|call me)\b/i],
  ["order_status", /(where is my order|order status|track(ing)?|deliver(y|ed)|shipping|shipment|dispatch|not (yet )?received)/i],
  ["refund", /(refund|return|money back|cancel(lation)? (my )?order|exchange)/i],
  ["billing", /(invoice|charged|charge|payment|bill|receipt|double charged)/i],
  ["technical", /(error|bug|not working|doesn'?t work|crash|can'?t (log ?in|sign ?in|access)|password|broken)/i],
  ["account", /(account|profile|email change|update my (details|address)|delete my)/i],
  ["pricing", /(price|pricing|cost|plan|discount|quote|bulk)/i],
  ["complaint", /(terrible|awful|worst|angry|unacceptable|disappointed|complain|frustrat)/i],
];

export function classifySupport(message: string): { intent: SupportIntent; urgency: SupportResult["urgency"] } {
  let intent: SupportIntent = "general";
  for (const [name, re] of INTENTS) {
    if (re.test(message)) {
      intent = name;
      break;
    }
  }
  let urgency: SupportResult["urgency"] = "normal";
  if (/(fraud|legal|lawyer|chargeback|charged twice|double charged|data breach|urgent|asap|immediately)/i.test(message)) urgency = "urgent";
  else if (intent === "complaint" || intent === "refund" || intent === "billing") urgency = "high";
  else if (intent === "pricing" || intent === "general") urgency = "low";
  return { intent, urgency };
}

export type SupportState = {
  input: SupportInput;
  message?: string;
  intent?: SupportIntent;
  urgency?: SupportResult["urgency"];
  relevant?: KnowledgeChunk[];
  hasContact?: boolean;
  output?: LogicOutput<SupportResult>;
};

function escalation(s: SupportState, reason: string, reply: string): SupportState {
  const contactAsk = s.hasContact ? "" : " Could you share your name and email so the team can follow up?";
  const result: SupportResult = {
    intent: s.intent!,
    urgency: s.urgency!,
    citations: [],
    ai_generated: false,
    reply: reply + contactAsk,
    escalate: true,
    escalation_reason: reason,
    grounded: false,
    needs_contact_details: !s.hasContact,
  };
  return { ...s, output: { ok: true, result, ai_request: null } };
}

const classify: Stage<SupportState> = {
  name: "classify intent and urgency",
  run(s) {
    const message = String(s.input?.message ?? "").trim();
    if (!message) return { ...s, output: fail("EMPTY_MESSAGE", "The message is empty.") };
    if (message.length > 4000) return { ...s, output: fail("MESSAGE_TOO_LONG", "Please keep messages under 4,000 characters.") };
    const { intent, urgency } = classifySupport(message);
    return { ...s, message, intent, urgency, hasContact: Boolean(s.input.customer?.email) };
  },
};

const searchKnowledge: Stage<SupportState> = {
  name: "search knowledge base",
  run(s) {
    const minRank = s.input.min_rank ?? 0.01;
    const relevant = (s.input.knowledge ?? []).filter((k) => k.rank >= minRank).sort((a, b) => b.rank - a.rank).slice(0, 5);
    return { ...s, relevant };
  },
};

const decideEscalation: Stage<SupportState> = {
  name: "decide escalation",
  run(s) {
    if (s.intent === "human_request") {
      return escalation(s, "Customer asked for a person.", "Of course — I've passed your conversation to our team and someone will get back to you.");
    }
    if (s.intent === "order_status" && !s.input.integrations?.order_system) {
      return escalation(
        s,
        "Order lookup requested but no order system is connected.",
        "I can't look up order details from here yet, so I've created a ticket for our team to check your order and reply with the exact status.",
      );
    }
    if (!s.relevant!.length) {
      return escalation(
        s,
        "No approved knowledge-base content matched the question.",
        "I couldn't find an answer to that in our approved help content, so I've passed it to our team rather than guess.",
      );
    }
    return s;
  },
};

const composeAnswer: Stage<SupportState> = {
  name: "compose answer with citations",
  run(s) {
    const { input, message, intent, urgency, relevant, hasContact } = s as Required<SupportState>;
    const best = relevant[0];
    const citations = [...new Map(relevant.map((k) => [k.document_id, { document_id: k.document_id, title: k.title }])).values()];
    const fallbackReply = `Here's what our "${best.title}" guide says:\n\n${truncate(best.content.trim(), 700)}\n\nIf this doesn't answer your question, reply and I'll pass it to the team.`;
    const result: SupportResult = {
      intent,
      urgency,
      ai_generated: false,
      reply: fallbackReply,
      escalate: urgency === "urgent",
      escalation_reason: urgency === "urgent" ? "Message marked urgent." : null,
      grounded: true,
      citations,
      needs_contact_details: urgency === "urgent" && !hasContact,
    };
    const ai: AiRequest = {
      system: [
        `You are the customer support assistant for ${input.company_name || "the business"}.`,
        "Answer ONLY using the knowledge excerpts provided. Do not invent policies, refund terms, prices, order statuses or customer details.",
        "If the excerpts do not fully answer the question, reply with a short apology and include the exact token [ESCALATE] so a human takes over.",
        "Be warm and concise (under 150 words). Do not mention 'excerpts' or internal tooling.",
      ].join("\n"),
      prompt: [
        "Knowledge excerpts:",
        ...relevant.map((k, i) => `[${i + 1}] ${k.title}\n${truncate(k.content, 1500)}`),
        "",
        "Conversation so far:",
        ...(input.history ?? []).slice(-6).map((h) => `${h.role}: ${truncate(h.content, 500)}`),
        `customer: ${message}`,
      ].join("\n"),
      max_tokens: 800,
    };
    return { ...s, output: { ok: true, result, ai_request: ai } };
  },
};

export const SUPPORT_STAGES: Stage<SupportState>[] = [classify, searchKnowledge, decideEscalation, composeAnswer];

export function answerSupport(input: SupportInput): LogicOutput<SupportResult> {
  return pipelineOutput(runStages(SUPPORT_STAGES, { input }));
}

export function mergeSupportAi(result: SupportResult, aiResponse: unknown): SupportResult {
  const text = readClaudeText(aiResponse);
  if (!text || !result.grounded) return result;
  if (text.includes("[ESCALATE]")) {
    return {
      ...result,
      reply: text.replace("[ESCALATE]", "").trim() || "I've passed your question to our team so they can answer it properly.",
      escalate: true,
      escalation_reason: "Knowledge base did not fully answer the question.",
      ai_generated: true,
    };
  }
  return { ...result, reply: text.slice(0, 3000), ai_generated: true };
}
