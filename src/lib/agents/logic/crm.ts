import { type AiRequest, type LogicOutput, type Stage, extractJson, fail, pipelineOutput, readClaudeText, runStages } from "./common";

export type CrmEventInput = {
  event: "contact.created" | "contact.updated" | "deal.created" | "deal.stage_changed";
  contact?: {
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    status: string;
    previous_status?: string | null;
    consent_status?: string;
    source?: string | null;
  } | null;
  deal?: { id: string; title: string; stage: string; previous_stage?: string | null; value: number; currency: string } | null;
  sender_name?: string | null;
};

export type CrmAction =
  | { type: "create_task"; subject: string; body: string | null; due_in_days: number; contact_id: string | null; deal_id: string | null }
  | { type: "update_contact_status"; contact_id: string; status: string }
  | { type: "create_email_draft"; contact_id: string; to: string; subject: string; body: string };

export type CrmEventResult = { event: string; actions: CrmAction[]; log: string[]; ai_generated: boolean };

export type CrmState = { input: CrmEventInput; actions?: CrmAction[]; log?: string[]; output?: LogicOutput<CrmEventResult> };

const readEvent: Stage<CrmState> = {
  name: "read event",
  run(s) {
    const input = s.input;
    if (!input?.event) return { ...s, output: fail("INVALID_INPUT", "Event type is required.") };
    const c = input.contact ?? null;
    const d = input.deal ?? null;
    switch (input.event) {
      case "contact.created":
      case "contact.updated":
        if (!c) return { ...s, output: fail("INVALID_INPUT", `${input.event} requires a contact.`) };
        break;
      case "deal.created":
      case "deal.stage_changed":
        if (!d) return { ...s, output: fail("INVALID_INPUT", `${input.event} requires a deal.`) };
        break;
      default:
        return { ...s, output: fail("UNKNOWN_EVENT", `Unsupported CRM event "${String(input.event)}".`) };
    }
    return { ...s, actions: [], log: [] };
  },
};

const planTasks: Stage<CrmState> = {
  name: "plan tasks",
  run(s) {
    const input = s.input;
    const actions: CrmAction[] = [...s.actions!];
    const log: string[] = [...s.log!];
    const c = input.contact ?? null;
    const d = input.deal ?? null;

    switch (input.event) {
      case "contact.created": {
        if (c!.status === "lead" || c!.status === "qualified") {
          actions.push({ type: "create_task", subject: `Follow up with ${c!.name}`, body: c!.source ? `New lead from ${c!.source}.` : "New lead.", due_in_days: 1, contact_id: c!.id, deal_id: null });
          log.push("New lead: follow-up task due in 1 day.");
        } else {
          log.push(`Contact created with status "${c!.status}": no automation.`);
        }
        break;
      }
      case "contact.updated": {
        if (c!.previous_status !== c!.status && c!.status === "qualified") {
          actions.push({ type: "create_task", subject: `Book a discovery call with ${c!.name}`, body: null, due_in_days: 2, contact_id: c!.id, deal_id: null });
          log.push("Lead qualified: discovery call task created.");
        } else {
          log.push("No rule matched this update.");
        }
        break;
      }
      case "deal.created": {
        actions.push({ type: "create_task", subject: `Qualify deal: ${d!.title}`, body: `Value ${d!.currency} ${d!.value.toLocaleString("en-US")}.`, due_in_days: 2, contact_id: c?.id ?? null, deal_id: d!.id });
        log.push("Deal created: qualification task due in 2 days.");
        break;
      }
      case "deal.stage_changed": {
        const task = (subject: string, days: number) => actions.push({ type: "create_task", subject, body: null, due_in_days: days, contact_id: c?.id ?? null, deal_id: d!.id });
        switch (d!.stage) {
          case "qualified": task(`Prepare proposal for ${d!.title}`, 3); break;
          case "proposal": task(`Follow up on proposal: ${d!.title}`, 2); break;
          case "negotiation": task(`Check in on negotiation: ${d!.title}`, 3); break;
          case "won":
            task(`Kick off onboarding for ${d!.title}`, 1);
            if (c && c.status !== "customer") {
              actions.push({ type: "update_contact_status", contact_id: c.id, status: "customer" });
              log.push(`${c.name} marked as customer.`);
            }
            break;
          case "lost": task(`Ask for feedback on lost deal: ${d!.title}`, 2); break;
          default: break;
        }
        log.push(`Deal moved ${d!.previous_stage ?? "?"} → ${d!.stage}: ${actions.length} action(s).`);
        break;
      }
    }
    return { ...s, actions, log };
  },
};

const draftIntroEmail: Stage<CrmState> = {
  name: "draft intro email",
  run(s) {
    const input = s.input;
    const actions: CrmAction[] = [...s.actions!];
    const log: string[] = [...s.log!];
    const c = input.contact ?? null;
    if (input.event === "contact.created" && c && (c.status === "lead" || c.status === "qualified")) {
      if (c.email && c.consent_status !== "opted_out") {
        const first = c.name.split(" ")[0];
        actions.push({
          type: "create_email_draft",
          contact_id: c.id,
          to: c.email,
          subject: c.company ? `Following up — ${c.company}` : "Thanks for getting in touch",
          body: [`Hi ${first},`, "", "Thanks for your interest. I'd love to learn more about what you're looking for.", "Would you have 15 minutes this week for a quick call?", "", "Best,", input.sender_name || "[Your name]"].join("\n"),
        });
        log.push("Intro email drafted (saved for review, not sent).");
      } else if (c.consent_status === "opted_out") {
        log.push("Contact opted out of email: no draft created.");
      }
    }
    const draft = actions.find((a) => a.type === "create_email_draft");
    const ai: AiRequest | null = draft && c
      ? {
          system: "You write a short, friendly first follow-up email (under 90 words) to a new sales lead. Use only the fields given; never invent details about the lead. Respond with JSON {\"subject\": string, \"body\": string}.",
          prompt: JSON.stringify({ lead: { name: c.name, company: c.company, source: c.source }, sender: input.sender_name || "[Your name]" }),
          max_tokens: 600,
        }
      : null;
    return { ...s, actions, log, output: { ok: true, result: { event: input.event, actions, log, ai_generated: false }, ai_request: ai } };
  },
};

export const CRM_STAGES: Stage<CrmState>[] = [readEvent, planTasks, draftIntroEmail];

export function planCrmEvent(input: CrmEventInput): LogicOutput<CrmEventResult> {
  return pipelineOutput(runStages(CRM_STAGES, { input }));
}

export function mergeCrmAi(result: CrmEventResult, aiResponse: unknown): CrmEventResult {
  const text = readClaudeText(aiResponse);
  const parsed = text ? (extractJson(text) as { subject?: unknown; body?: unknown } | null) : null;
  if (!parsed || typeof parsed.subject !== "string" || typeof parsed.body !== "string") return result;
  return {
    ...result,
    ai_generated: true,
    actions: result.actions.map((a) =>
      a.type === "create_email_draft" ? { ...a, subject: (parsed.subject as string).slice(0, 200), body: (parsed.body as string).slice(0, 4000) } : a,
    ),
  };
}
