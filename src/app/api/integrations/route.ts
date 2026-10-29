import { apiContext, json } from "@/lib/api";
import { handler } from "@/lib/errors";
import { getIntegrationStatuses } from "@/lib/integrations/status";

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  return json(await getIntegrationStatuses(ctx));
});
