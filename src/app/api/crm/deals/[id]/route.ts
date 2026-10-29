import { after } from "next/server";
import { apiContext, json } from "@/lib/api";
import { readJson } from "@/lib/agents/handlers/shared";
import { triggerCrmEvent } from "@/lib/agents/handlers/crm";
import { withUser } from "@/lib/db";
import { deleteDeal, updateDeal } from "@/lib/crm";
import { handler } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  const { before, deal } = await updateDeal(ctx, (await params).id, await readJson(req));
  if (before.stage !== deal.stage) {
    after(async () => {
      const contact = deal.contact_id
        ? await withUser(ctx.user.id, (tx) =>
            tx.one<{ id: string; name: string; email: string | null; company: string | null; status: string; consent_status: string }>(
              "select id, name, email, company, status, consent_status from public.contacts where id = $1 and organization_id = $2",
              [deal.contact_id, ctx.orgId],
            ),
          )
        : null;
      await triggerCrmEvent(
        ctx,
        {
          event: "deal.stage_changed",
          deal: { id: deal.id, title: deal.title, stage: deal.stage, previous_stage: before.stage, value: deal.value, currency: deal.currency },
          contact,
        },
        deal.id,
      );
    });
  }
  return json({ deal });
});

export const DELETE = handler(async (req: Request, { params }: Params) => {
  const ctx = await apiContext(req);
  await deleteDeal(ctx, (await params).id);
  return json({ ok: true });
});
