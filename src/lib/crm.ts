import "server-only";
import { z } from "zod";
import { audit } from "./audit";
import { assertCanWrite, type OrgContext } from "./auth/context";
import { withUser } from "./db";
import { Errors } from "./errors";
import { csvEscape, type Table } from "./files/tabular";

export const CONTACT_STATUSES = ["lead", "qualified", "customer", "unqualified", "churned"] as const;
export const DEAL_STAGES = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export const ACTIVITY_TYPES = ["note", "task", "call", "email", "meeting", "reminder"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  email: z
    .union([z.email("Enter a valid email.").max(320), z.literal("")])
    .nullish()
    .transform((v) => (v ? v.toLowerCase() : null)),
  phone: optionalText(40),
  company: optionalText(200),
  source: optionalText(80),
  status: z.enum(CONTACT_STATUSES).default("lead"),
  owner_id: z.uuid().nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  consent_status: z.enum(["unknown", "opted_in", "opted_out"]).default("unknown"),
  industry: optionalText(120),
  location: optionalText(120),
  company_size: optionalText(60),
});
export type ContactInput = z.infer<typeof contactSchema>;

/**
 * Zod 4's .partial() still fills in .default() values for missing keys, which
 * would silently reset fields on PATCH. Keep only the keys the client sent.
 */
function onlySentKeys<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const sent = raw && typeof raw === "object" ? new Set(Object.keys(raw)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
}

export const dealSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  contact_id: z.uuid().nullish(),
  value: z.coerce.number().min(0).max(1e12).default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  stage: z.enum(DEAL_STAGES).default("new"),
  expected_close_date: z.iso.date().nullish(),
  owner_id: z.uuid().nullish(),
});

export const activitySchema = z
  .object({
    contact_id: z.uuid().nullish(),
    deal_id: z.uuid().nullish(),
    type: z.enum(ACTIVITY_TYPES),
    subject: z.string().trim().min(1, "Subject is required.").max(300),
    body: optionalText(10000),
    due_at: z.iso.datetime({ offset: true }).nullish().or(z.iso.date().nullish()),
  })
  .refine((a) => a.contact_id || a.deal_id, "An activity must belong to a contact or a deal.");

export type Contact = ContactInput & { id: string; lead_score: number | null; is_demo: boolean; created_at: string; updated_at: string };
export type Deal = {
  id: string;
  title: string;
  contact_id: string | null;
  contact_name: string | null;
  value: number;
  currency: string;
  stage: (typeof DEAL_STAGES)[number];
  expected_close_date: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
};
export type Activity = {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  type: string;
  subject: string;
  body: string | null;
  due_at: string | null;
  completed_at: string | null;
  execution_id: string | null;
  created_at: string;
};

const CONTACT_COLS = `id, name, email, phone, company, source, status, owner_id, tags, lead_score, consent_status,
  industry, location, company_size, is_demo, created_at, updated_at`;

export const contactFilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  source: z.string().trim().max(80).optional(),
  sort: z.enum(["created_at", "name", "company", "lead_score", "updated_at"]).default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function listContacts(ctx: OrgContext, raw: unknown) {
  const f = contactFilterSchema.parse(raw);
  const where = ["organization_id = $1"];
  const params: unknown[] = [ctx.orgId];
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    where.push(`(name ilike $${params.length} or email ilike $${params.length} or company ilike $${params.length})`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.source) {
    params.push(f.source);
    where.push(`source = $${params.length}`);
  }
  return withUser(ctx.user.id, async (tx) => {
    const total = await tx.one<{ n: number }>(`select count(*)::int as n from public.contacts where ${where.join(" and ")}`, params);
    const rows = await tx.query<Contact>(
      `select ${CONTACT_COLS} from public.contacts where ${where.join(" and ")}
        order by ${f.sort} ${f.dir} nulls last, id
        limit ${f.limit} offset ${f.offset}`,
      params,
    );
    const sources = await tx.query<{ source: string }>(
      "select distinct source from public.contacts where organization_id = $1 and source is not null order by source limit 50",
      [ctx.orgId],
    );
    return { total: total?.n ?? 0, contacts: rows, sources: sources.map((s) => s.source) };
  });
}

export async function getContact(ctx: OrgContext, id: string) {
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Contact");
  return withUser(ctx.user.id, async (tx) => {
    const contact = await tx.one<Contact>(`select ${CONTACT_COLS} from public.contacts where id = $1 and organization_id = $2`, [id, ctx.orgId]);
    if (!contact) throw Errors.notFound("Contact");
    const deals = await tx.query<Deal>(
      `select id, title, contact_id, null as contact_name, value::float8 as value, currency, stage, expected_close_date::text, is_demo, created_at, updated_at
         from public.deals where contact_id = $1 and organization_id = $2 order by created_at desc`,
      [id, ctx.orgId],
    );
    const activities = await tx.query<Activity>(
      `select id, contact_id, deal_id, type, subject, body, due_at, completed_at, execution_id, created_at
         from public.activities
        where organization_id = $2 and (contact_id = $1 or deal_id in (select id from public.deals where contact_id = $1))
        order by created_at desc limit 200`,
      [id, ctx.orgId],
    );
    return { contact, deals, activities };
  });
}

export async function createContact(ctx: OrgContext, raw: unknown) {
  assertCanWrite(ctx);
  const c = contactSchema.parse(raw);
  return withUser(ctx.user.id, async (tx) => {
    if (c.email) {
      const dup = await tx.one("select 1 from public.contacts where organization_id = $1 and lower(email) = $2", [ctx.orgId, c.email]);
      if (dup) throw Errors.conflict("A contact with this email already exists.");
    }
    return (await tx.one<Contact>(
      `insert into public.contacts (organization_id, name, email, phone, company, source, status, owner_id, tags, consent_status,
                                    industry, location, company_size, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, auth.uid()), $9, $10, $11, $12, $13, auth.uid())
       returning ${CONTACT_COLS}`,
      [ctx.orgId, c.name, c.email, c.phone, c.company, c.source, c.status, c.owner_id ?? null, c.tags, c.consent_status, c.industry, c.location, c.company_size],
    ))!;
  });
}

export async function updateContact(ctx: OrgContext, id: string, raw: unknown) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Contact");
  const patch = onlySentKeys(contactSchema.partial().parse(raw), raw);
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!fields.length) throw Errors.invalid("Nothing to update.");
  return withUser(ctx.user.id, async (tx) => {
    const before = await tx.one<Contact>(`select ${CONTACT_COLS} from public.contacts where id = $1 and organization_id = $2 for update`, [id, ctx.orgId]);
    if (!before) throw Errors.notFound("Contact");
    const sets = fields.map(([k], i) => `${k} = $${i + 3}`);
    const updated = await tx.one<Contact>(
      `update public.contacts set ${sets.join(", ")} where id = $1 and organization_id = $2 returning ${CONTACT_COLS}`,
      [id, ctx.orgId, ...fields.map(([, v]) => v)],
    );
    return { before, contact: updated! };
  }).catch((err) => {
    if ((err as { code?: string }).code === "23505") throw Errors.conflict("A contact with this email already exists.");
    throw err;
  });
}

export async function deleteContact(ctx: OrgContext, id: string) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Contact");
  const deleted = await withUser(ctx.user.id, (tx) =>
    tx.one<{ id: string; name: string }>("delete from public.contacts where id = $1 and organization_id = $2 returning id, name", [id, ctx.orgId]),
  );
  if (!deleted) throw Errors.notFound("Contact");
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.contact_deleted", entityType: "contact", entityId: id });
}

const IMPORT_MAP: [keyof ContactInput, RegExp][] = [
  ["name", /^(full_?name|name|contact(_name)?)$/],
  ["email", /^e-?mail(_address)?$/],
  ["phone", /^(phone|mobile|tel(ephone)?)(_number)?$/],
  ["company", /^(company|organi[sz]ation|business|account)(_name)?$/],
  ["source", /^(source|lead_source|channel)$/],
  ["status", /^(status|stage|lifecycle)$/],
  ["industry", /^(industry|sector)$/],
  ["location", /^(location|city|region|state)$/],
  ["company_size", /^(company_size|size|employees)$/],
];

export async function importContacts(ctx: OrgContext, table: Table) {
  assertCanWrite(ctx);
  const norm = (h: string) => h.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const mapping = new Map<keyof ContactInput, string>();
  for (const col of table.columns) {
    const hit = IMPORT_MAP.find(([, re]) => re.test(norm(col)));
    if (hit && !mapping.has(hit[0])) mapping.set(hit[0], col);
  }
  const first = table.columns.find((c) => /^first_?name$/.test(norm(c)));
  const last = table.columns.find((c) => /^last_?name$/.test(norm(c)));
  if (!mapping.has("name") && !first) throw Errors.invalid('The CSV needs a "name" (or "first_name") column.');
  if (table.rows.length > 5000) throw Errors.invalid("Import up to 5,000 contacts at a time.");

  const errors: { row: number; message: string }[] = [];
  let created = 0;
  let skipped = 0;
  await withUser(ctx.user.id, async (tx) => {
    for (let i = 0; i < table.rows.length; i++) {
      const r = table.rows[i];
      const pick = (k: keyof ContactInput) => (mapping.has(k) ? String(r[mapping.get(k)!] ?? "").trim() : "");
      const name = pick("name") || [first ? String(r[first] ?? "") : "", last ? String(r[last] ?? "") : ""].join(" ").trim();
      const status = pick("status").toLowerCase();
      const parsed = contactSchema.safeParse({
        name,
        email: pick("email") || null,
        phone: pick("phone") || null,
        company: pick("company") || null,
        source: pick("source") || "CSV import",
        status: (CONTACT_STATUSES as readonly string[]).includes(status) ? status : "lead",
        industry: pick("industry") || null,
        location: pick("location") || null,
        company_size: pick("company_size") || null,
      });
      if (!parsed.success) {
        errors.push({ row: i + 2, message: parsed.error.issues[0].message });
        continue;
      }
      const c = parsed.data;
      const row = await tx.one(
        `insert into public.contacts (organization_id, name, email, phone, company, source, status, industry, location, company_size, owner_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, auth.uid(), auth.uid())
         on conflict (organization_id, lower(email)) where email is not null do nothing
         returning id`,
        [ctx.orgId, c.name, c.email, c.phone, c.company, c.source, c.status, c.industry, c.location, c.company_size],
      );
      if (row) created++;
      else skipped++;
    }
  });
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.contacts_imported", metadata: { created, skipped, errors: errors.length } });
  return { created, skipped_duplicates: skipped, errors: errors.slice(0, 100) };
}

export async function exportContactsCsv(ctx: OrgContext): Promise<string> {
  const rows = await withUser(ctx.user.id, (tx) =>
    tx.query<Contact>(`select ${CONTACT_COLS} from public.contacts where organization_id = $1 order by created_at`, [ctx.orgId]),
  );
  const cols: (keyof Contact)[] = ["name", "email", "phone", "company", "source", "status", "lead_score", "consent_status", "industry", "location", "company_size", "created_at"];
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.contacts_exported", metadata: { count: rows.length } });
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(c === "created_at" ? new Date(r[c] as string).toISOString() : r[c])).join(","))].join("\n");
}

const DEAL_COLS = `d.id, d.title, d.contact_id, c.name as contact_name, d.value::float8 as value, d.currency, d.stage,
  d.expected_close_date::text, d.is_demo, d.created_at, d.updated_at`;

export async function listDeals(ctx: OrgContext) {
  return withUser(ctx.user.id, (tx) =>
    tx.query<Deal>(
      `select ${DEAL_COLS} from public.deals d left join public.contacts c on c.id = d.contact_id
        where d.organization_id = $1 order by d.updated_at desc limit 500`,
      [ctx.orgId],
    ),
  );
}

export async function createDeal(ctx: OrgContext, raw: unknown) {
  assertCanWrite(ctx);
  const d = dealSchema.parse(raw);
  return withUser(ctx.user.id, async (tx) => {
    if (d.contact_id) {
      const c = await tx.one("select 1 from public.contacts where id = $1 and organization_id = $2", [d.contact_id, ctx.orgId]);
      if (!c) throw Errors.invalid("That contact doesn't exist.");
    }
    const row = await tx.one<{ id: string }>(
      `insert into public.deals (organization_id, contact_id, title, value, currency, stage, expected_close_date, owner_id, created_by,
                                 closed_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, auth.uid()), auth.uid(), case when $6 in ('won', 'lost') then now() end)
       returning id`,
      [ctx.orgId, d.contact_id ?? null, d.title, d.value, d.currency ?? ctx.currency, d.stage, d.expected_close_date ?? null, d.owner_id ?? null],
    );
    return (await tx.one<Deal>(`select ${DEAL_COLS} from public.deals d left join public.contacts c on c.id = d.contact_id where d.id = $1`, [row!.id]))!;
  });
}

export async function updateDeal(ctx: OrgContext, id: string, raw: unknown) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Deal");
  const patch = onlySentKeys(dealSchema.partial().parse(raw), raw);
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!fields.length) throw Errors.invalid("Nothing to update.");
  return withUser(ctx.user.id, async (tx) => {
    const before = await tx.one<Deal>(`select ${DEAL_COLS} from public.deals d left join public.contacts c on c.id = d.contact_id where d.id = $1 and d.organization_id = $2`, [id, ctx.orgId]);
    if (!before) throw Errors.notFound("Deal");
    const sets = fields.map(([k], i) => `${k} = $${i + 3}`);
    await tx.query(`update public.deals set ${sets.join(", ")} where id = $1 and organization_id = $2`, [id, ctx.orgId, ...fields.map(([, v]) => v)]);
    if (patch.stage) {
      await tx.query(
        "update public.deals set closed_at = case when stage in ('won', 'lost') then coalesce(closed_at, now()) else null end where id = $1",
        [id],
      );
    }
    const deal = (await tx.one<Deal>(`select ${DEAL_COLS} from public.deals d left join public.contacts c on c.id = d.contact_id where d.id = $1`, [id]))!;
    return { before, deal };
  });
}

export async function deleteDeal(ctx: OrgContext, id: string) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Deal");
  const row = await withUser(ctx.user.id, (tx) => tx.one("delete from public.deals where id = $1 and organization_id = $2 returning id", [id, ctx.orgId]));
  if (!row) throw Errors.notFound("Deal");
  await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "crm.deal_deleted", entityType: "deal", entityId: id });
}

export async function createActivity(ctx: OrgContext, raw: unknown) {
  assertCanWrite(ctx);
  const a = activitySchema.parse(raw);
  return withUser(ctx.user.id, async (tx) => {
    const row = await tx.one<Activity>(
      `insert into public.activities (organization_id, contact_id, deal_id, type, subject, body, due_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, auth.uid())
       returning id, contact_id, deal_id, type, subject, body, due_at, completed_at, execution_id, created_at`,
      [ctx.orgId, a.contact_id ?? null, a.deal_id ?? null, a.type, a.subject, a.body, a.due_at ?? null],
    ).catch((err) => {
      if ((err as { code?: string }).code === "23503") throw Errors.invalid("That contact or deal doesn't exist.");
      throw err;
    });
    return row!;
  });
}

export async function updateActivity(ctx: OrgContext, id: string, raw: unknown) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Activity");
  const { completed } = z.object({ completed: z.boolean() }).parse(raw);
  const row = await withUser(ctx.user.id, (tx) =>
    tx.one<Activity>(
      `update public.activities set completed_at = case when $3 then now() else null end
        where id = $1 and organization_id = $2
        returning id, contact_id, deal_id, type, subject, body, due_at, completed_at, execution_id, created_at`,
      [id, ctx.orgId, completed],
    ),
  );
  if (!row) throw Errors.notFound("Activity");
  return row;
}

export async function deleteActivity(ctx: OrgContext, id: string) {
  assertCanWrite(ctx);
  if (!z.uuid().safeParse(id).success) throw Errors.notFound("Activity");
  const row = await withUser(ctx.user.id, (tx) => tx.one("delete from public.activities where id = $1 and organization_id = $2 returning id", [id, ctx.orgId]));
  if (!row) throw Errors.notFound("Activity");
}

export async function listOpenTasks(ctx: OrgContext, limit = 20) {
  return withUser(ctx.user.id, (tx) =>
    tx.query<Activity & { contact_name: string | null }>(
      `select a.id, a.contact_id, a.deal_id, a.type, a.subject, a.body, a.due_at, a.completed_at, a.execution_id, a.created_at, c.name as contact_name
         from public.activities a left join public.contacts c on c.id = a.contact_id
        where a.organization_id = $1 and a.type in ('task', 'reminder') and a.completed_at is null
        order by a.due_at nulls last limit $2`,
      [ctx.orgId, limit],
    ),
  );
}

/** Clearly labeled demo records (is_demo = true) so the CRM and charts can be explored. */
export async function seedDemoData(ctx: OrgContext) {
  assertCanWrite(ctx);
  const people = [
    ["Aarav Mehta", "Giftcraft Studio", "Website", "lead", 0, "new"],
    ["Priya Sharma", "Delhi Corporate Gifts", "Referral", "qualified", 85000, "qualified"],
    ["Rohan Gupta", "Hamper House", "LinkedIn", "customer", 120000, "won"],
    ["Neha Kapoor", "BrandBox India", "Website", "lead", 45000, "contacted"],
    ["Vikram Singh", "Festive Packs", "Trade show", "qualified", 210000, "proposal"],
    ["Ananya Iyer", "Curated Co.", "Referral", "qualified", 95000, "negotiation"],
    ["Kabir Malhotra", "Office Treats", "Cold email", "unqualified", 30000, "lost"],
    ["Sara Thomas", "Northstar Events", "Website", "lead", 0, "new"],
  ] as const;
  return withUser(ctx.user.id, async (tx) => {
    let created = 0;
    for (const [i, [name, company, source, status, value, stage]] of people.entries()) {
      const email = `${name.split(" ")[0].toLowerCase()}.demo@example.com`;
      const c = await tx.one<{ id: string }>(
        `insert into public.contacts (organization_id, name, email, company, source, status, is_demo, created_by, owner_id, location, industry, created_at)
         values ($1, $2, $3, $4, $5, $6, true, auth.uid(), auth.uid(), 'Delhi NCR', 'Corporate gifting', now() - ($7::int * interval '3 days'))
         on conflict (organization_id, lower(email)) where email is not null do nothing returning id`,
        [ctx.orgId, name, email, company, source, status, i],
      );
      if (!c) continue;
      created++;
      if (value > 0) {
        await tx.query(
          `insert into public.deals (organization_id, contact_id, title, value, currency, stage, is_demo, created_by, owner_id, closed_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, true, auth.uid(), auth.uid(), case when $6 in ('won','lost') then now() end, now() - ($7::int * interval '4 days'))`,
          [ctx.orgId, c.id, `${company} — Diwali order`, value, ctx.currency, stage, i],
        );
      }
      await tx.query(
        `insert into public.activities (organization_id, contact_id, type, subject, due_at, created_by)
         values ($1, $2, 'task', $3, now() + (($4::int - 3) * interval '1 day'), auth.uid())`,
        [ctx.orgId, c.id, `Follow up with ${name.split(" ")[0]} (demo)`, i],
      );
    }
    return { created };
  });
}

export async function clearDemoData(ctx: OrgContext) {
  assertCanWrite(ctx);
  return withUser(ctx.user.id, async (tx) => {
    await tx.query("delete from public.deals where organization_id = $1 and is_demo", [ctx.orgId]);
    const rows = await tx.query("delete from public.contacts where organization_id = $1 and is_demo returning id", [ctx.orgId]);
    return { removed: rows.length };
  });
}
