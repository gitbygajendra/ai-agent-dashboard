import { z } from "zod";
import { apiContext, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { assertAdmin } from "@/lib/auth/context";
import { readJson } from "@/lib/agents/handlers/shared";
import { AGENT_SLUGS } from "@/lib/agents/registry";
import { withUser } from "@/lib/db";
import { handler } from "@/lib/errors";

const EMAIL_CATEGORIES = ["customer_inquiry", "support", "sales_lead", "billing", "scheduling", "internal", "other"] as const;

const schema = z.object({
  organization: z
    .object({ name: z.string().trim().min(1).max(120).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() })
    .optional(),
  agents: z
    .array(
      z.object({
        slug: z.enum(AGENT_SLUGS),
        enabled: z.boolean().optional(),
        auto_send: z.object({ enabled: z.boolean(), categories: z.array(z.enum(EMAIL_CATEGORIES)).max(7) }).optional(),
      }),
    )
    .max(7)
    .optional(),
});

/** Workspace settings. Owners/admins only; RLS enforces the same rule in the database. */
export const PATCH = handler(async (req: Request) => {
  const ctx = await apiContext(req);
  assertAdmin(ctx);
  const body = schema.parse(await readJson(req));
  await withUser(ctx.user.id, async (tx) => {
    if (body.organization) {
      await tx.query(
        "update public.organizations set name = coalesce($2, name), currency = coalesce($3, currency) where id = $1",
        [ctx.orgId, body.organization.name ?? null, body.organization.currency ?? null],
      );
    }
    for (const a of body.agents ?? []) {
      if (a.enabled !== undefined) {
        await tx.query("update public.agents set enabled = $3 where organization_id = $1 and slug = $2", [ctx.orgId, a.slug, a.enabled]);
      }
      if (a.auto_send && a.slug === "email-automation-agent") {
        await tx.query(
          "update public.agents set config = jsonb_set(config, '{auto_send}', $3::jsonb) where organization_id = $1 and slug = $2",
          [ctx.orgId, a.slug, JSON.stringify(a.auto_send)],
        );
      }
    }
  });
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "settings.updated", metadata: { organization: Boolean(body.organization), agents: body.agents?.map((a) => a.slug) ?? [] } });
  return json({ ok: true });
});
