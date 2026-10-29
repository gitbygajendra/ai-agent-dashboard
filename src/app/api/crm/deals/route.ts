import { after } from "next/server";
import { apiContext, json } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { triggerCrmEvent } from "@/lib/agents/handlers/crm";
import { createDeal, listDeals } from "@/lib/crm";
import { handler } from "@/lib/errors";

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  return json({ deals: await listDeals(ctx) });
});

export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const deal = await createDeal(ctx, await readJson(req));
  after(() =>
    triggerCrmEvent(
      ctx,
      {
        event: "deal.created",
        deal: { id: deal.id, title: deal.title, stage: deal.stage, value: deal.value, currency: deal.currency },
        contact: deal.contact_id ? { id: deal.contact_id, name: deal.contact_name ?? "", email: null, company: null, status: "lead" } : null,
      },
      deal.id,
    ),
  );
  return json({ deal }, { status: 201 });
});
