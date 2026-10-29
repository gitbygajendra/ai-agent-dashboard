import { after } from "next/server";
import { apiContext, json, searchParams } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { triggerCrmEvent } from "@/lib/agents/handlers/crm";
import { createContact, listContacts } from "@/lib/crm";
import { handler } from "@/lib/errors";

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  return json(await listContacts(ctx, searchParams(req)));
});

export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const contact = await createContact(ctx, await readJson(req));
  after(() =>
    triggerCrmEvent(
      ctx,
      {
        event: "contact.created",
        contact: { id: contact.id, name: contact.name, email: contact.email, company: contact.company, status: contact.status, consent_status: contact.consent_status, source: contact.source },
      },
      contact.id,
    ),
  );
  return json({ contact }, { status: 201 });
});
