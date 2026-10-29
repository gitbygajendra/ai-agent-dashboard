import { apiContext } from "@/lib/api";
import { exportContactsCsv } from "@/lib/crm";
import { handler } from "@/lib/errors";

export const GET = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  const csv = await exportContactsCsv(ctx);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
});
