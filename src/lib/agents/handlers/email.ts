import "server-only";
import { z } from "zod";
import { assertCanWrite } from "../../auth/context";
import { withService } from "../../db";
import { getObject, objectKey, putObject } from "../../storage";
import { listInbox } from "../../integrations/gmail";
import type { EmailInput, EmailMessage, EmailResult } from "../logic/email";
import type { AgentHandler } from "../types";
import { readJson } from "./shared";
import { applyEmailAutomationRules } from "../approvals";

const pastedEmail = z.object({
  from: z.string().trim().max(320).default(""),
  subject: z.string().trim().max(500).default(""),
  body: z.string().trim().min(1, "Paste the email text.").max(20000),
});

const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pasted"),
    emails: z.array(pastedEmail).min(1).max(20),
    instructions: z.string().trim().max(2000).nullish(),
    tone: z.enum(["friendly", "formal", "concise"]).default("friendly"),
  }),
  z.object({
    mode: z.literal("inbox"),
    query: z.string().trim().max(300).default("in:inbox newer_than:7d -category:promotions -from:me"),
    max: z.number().int().min(1).max(25).default(15),
    instructions: z.string().trim().max(2000).nullish(),
    tone: z.enum(["friendly", "formal", "concise"]).default("friendly"),
  }),
]);

type EmailRef = { mode: "pasted" | "inbox"; path?: string; query?: string; max?: number; instructions?: string | null; tone: EmailInput["tone"] };

export const emailHandler: AgentHandler = {
  async prepare(ctx, req) {
    assertCanWrite(ctx);
    const body = bodySchema.parse(await readJson(req, 300_000));
    let emails: EmailMessage[];
    let ref: EmailRef;
    if (body.mode === "pasted") {
      emails = body.emails.map((e, i) => ({ id: `pasted-${i + 1}`, from: e.from, subject: e.subject || "(no subject)", body: e.body, source: "pasted" }));
      const stored = await putObject(objectKey(ctx.orgId, "emails", "pasted.json"), Buffer.from(JSON.stringify(emails)), "application/octet-stream");
      ref = { mode: "pasted", path: stored.path, instructions: body.instructions ?? null, tone: body.tone };
    } else {
      emails = await listInbox(ctx.orgId, body.query, body.max);
      ref = { mode: "inbox", query: body.query, max: body.max, instructions: body.instructions ?? null, tone: body.tone };
    }
    const input: EmailInput = { emails, instructions: ref.instructions, sender_name: ctx.fullName, tone: ref.tone };
    return {
      input,
      inputSummary: { mode: body.mode, email_count: emails.length, subjects: emails.slice(0, 5).map((e) => e.subject.slice(0, 80)) },
      inputRef: ref,
    };
  },
  async rebuild(ctx, execution) {
    const ref = execution.input_ref as EmailRef;
    const emails =
      ref.mode === "pasted"
        ? (JSON.parse((await getObject(ref.path!, ctx.orgId)).toString("utf8")) as EmailMessage[])
        : await listInbox(ctx.orgId, ref.query, ref.max);
    return { emails, instructions: ref.instructions, sender_name: ctx.fullName, tone: ref.tone } satisfies EmailInput;
  },
  async onComplete(_tx, _execution, result) {
    const r = result as EmailResult;
    // Nothing is ever sent from here: drafts wait for a person to approve them.
    return r.counts?.drafts > 0 ? { status: "awaiting_approval" } : {};
  },
  async afterCommit(execution) {
    if (execution.status !== "awaiting_approval") return;
    const agent = await withService((tx) =>
      tx.one<{ config: { auto_send?: { enabled?: boolean; categories?: string[] } } }>(
        "select config from public.agents where organization_id = $1 and slug = 'email-automation-agent'",
        [execution.organization_id],
      ),
    );
    const rule = agent?.config?.auto_send;
    if (rule?.enabled && Array.isArray(rule.categories) && rule.categories.length) {
      await applyEmailAutomationRules(execution.id, rule.categories);
    }
  },
};
