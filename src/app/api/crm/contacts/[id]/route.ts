import { after } from "next/server";
import { apiContext, json } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { triggerCrmEvent } from "@/lib/agents/handlers/crm";
import { deleteContact, getContact, updateContact } from "@/lib/crm";
import { handler } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

export const GET = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  return json(await getContact(ctx, (await params).id));
});

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  const { before, contact } = await updateContact(ctx, (await params).id, await readJson(req));
  if (before.status !== contact.status) {
    after(() =>
      triggerCrmEvent(
        ctx,
        {
          event: "contact.updated",
          contact: { id: contact.id, name: contact.name, email: contact.email, company: contact.company, status: contact.status, previous_status: before.status, consent_status: contact.consent_status, source: contact.source },
        },
        contact.id,
      ),
    );
  }
  return json({ contact });
});

export const DELETE = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  await deleteContact(ctx, (await params).id);
  return json({ ok: true });
});
