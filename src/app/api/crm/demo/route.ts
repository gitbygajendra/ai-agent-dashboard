import { apiContext, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { clearDemoData, seedDemoData } from "@/lib/crm";
import { handler } from "@/lib/errors";

/** Add or remove clearly labeled demo CRM records. */
export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const result = await seedDemoData(ctx);
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.demo_seeded", metadata: result });
  return json(result);
});

export const DELETE = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const result = await clearDemoData(ctx);
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.demo_cleared", metadata: result });
  return json(result);
});
