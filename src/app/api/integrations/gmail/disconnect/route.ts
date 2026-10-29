import { apiContext, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/auth/context";
import { handler } from "@/lib/errors";
import { disconnectGmail } from "@/lib/integrations/gmail";

export const POST = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  assertAdmin(ctx);
  await disconnectGmail(ctx.orgId);
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "integration.disconnected", entityType: "integration", entityId: "gmail" });
  return json({ ok: true });
});
