/**
 * Row Level Security integration test against a real PostgreSQL database with
 * the migrations applied (supabase/local/000_supabase_compat.sql + supabase/migrations).
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/agentdash npx vitest run tests/rls.test.ts
 *
 * Skipped when TEST_DATABASE_URL is not set. Connects as a superuser (needed to
 * insert into auth.users and to set up memberships) and switches to the
 * `authenticated` / `service_role` roles per transaction, the same way
 * src/lib/db.ts does.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

type Db = pg.Client;
type PgError = Error & { code?: string };

describe.skipIf(!url)("row level security", () => {
  let db: Db;
  const users: string[] = [];
  const orgs: string[] = [];
  let userA = "";
  let userB = "";
  let viewer = "";
  let orgA = "";
  let orgB = "";
  let contactA = "";

  /** Run fn as an authenticated user inside a transaction (commit on success, rollback on error). */
  async function asUser<T>(userId: string, fn: (c: Db) => Promise<T>): Promise<T> {
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await db.query("set local role authenticated");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }

  /** Run fn as service_role (bypasses RLS, but not constraints). */
  async function asService<T>(fn: (c: Db) => Promise<T>): Promise<T> {
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await db.query("set local role service_role");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }

  async function pgError(p: Promise<unknown>): Promise<PgError> {
    return p.then(
      () => {
        throw new Error("expected the query to fail");
      },
      (e: PgError) => e,
    );
  }

  async function createUser(label: string): Promise<{ id: string; org: string }> {
    const email = `rls-${label}-${randomUUID()}@example.test`;
    const { rows } = await db.query<{ id: string }>("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [
      email,
      JSON.stringify({ organization_name: `RLS test ${label}` }),
    ]);
    const id = rows[0].id;
    users.push(id);
    const m = await db.query<{ organization_id: string }>("select organization_id from public.organization_members where user_id = $1 and role = 'owner'", [id]);
    expect(m.rows).toHaveLength(1);
    orgs.push(m.rows[0].organization_id);
    return { id, org: m.rows[0].organization_id };
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const a = await createUser("a");
    const b = await createUser("b");
    const v = await createUser("viewer");
    userA = a.id;
    orgA = a.org;
    userB = b.id;
    orgB = b.org;
    viewer = v.id;
    // As the superuser: make the third user a viewer of org A.
    await db.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'viewer')", [orgA, viewer]);

    const { rows } = await asUser(userA, (c) =>
      c.query<{ id: string }>("insert into public.contacts (organization_id, name, email) values ($1, 'Alice Customer', $2) returning id", [orgA, `alice-${randomUUID()}@example.test`]),
    );
    contactA = rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (orgs.length) {
        await db.query("delete from public.deals where organization_id = any($1::uuid[])", [orgs]);
        await db.query("delete from public.organizations where id = any($1::uuid[])", [orgs]);
      }
      if (users.length) await db.query("delete from auth.users where id = any($1::uuid[])", [users]);
    } finally {
      await db.end();
    }
  });

  it("the signup trigger bootstrapped an org with 7 agents and 5 integrations", async () => {
    const agents = await db.query("select slug from public.agents where organization_id = $1", [orgA]);
    const integrations = await db.query("select provider from public.integrations where organization_id = $1", [orgA]);
    expect(agents.rowCount).toBe(7);
    expect(integrations.rowCount).toBe(5);
    expect(orgA).not.toBe(orgB);
  });

  describe("contacts", () => {
    it("user A can insert and select its own contact", async () => {
      expect(contactA).toMatch(/^[0-9a-f-]{36}$/);
      const { rows } = await asUser(userA, (c) => c.query("select id, name, organization_id from public.contacts where id = $1", [contactA]));
      expect(rows).toEqual([{ id: contactA, name: "Alice Customer", organization_id: orgA }]);
    });

    it("user B cannot select A's contacts", async () => {
      const byId = await asUser(userB, (c) => c.query("select id from public.contacts where id = $1", [contactA]));
      expect(byId.rowCount).toBe(0);
      const byOrg = await asUser(userB, (c) => c.query("select id from public.contacts where organization_id = $1", [orgA]));
      expect(byOrg.rowCount).toBe(0);
    });

    it("user B cannot update or delete A's contacts (0 rows affected)", async () => {
      const upd = await asUser(userB, (c) => c.query("update public.contacts set name = 'Hacked' where id = $1", [contactA]));
      expect(upd.rowCount).toBe(0);
      const del = await asUser(userB, (c) => c.query("delete from public.contacts where id = $1", [contactA]));
      expect(del.rowCount).toBe(0);
      const check = await db.query("select name from public.contacts where id = $1", [contactA]);
      expect(check.rows).toEqual([{ name: "Alice Customer" }]);
    });

    it("user B cannot insert a contact into org A", async () => {
      const err = await pgError(asUser(userB, (c) => c.query("insert into public.contacts (organization_id, name) values ($1, 'Planted')", [orgA])));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/row-level security policy for table "contacts"/);
      const check = await db.query("select 1 from public.contacts where organization_id = $1 and name = 'Planted'", [orgA]);
      expect(check.rowCount).toBe(0);
    });

    it("user B cannot move its own contact into org A", async () => {
      const { rows } = await asUser(userB, (c) => c.query<{ id: string }>("insert into public.contacts (organization_id, name) values ($1, 'Bob Contact') returning id", [orgB]));
      const err = await pgError(asUser(userB, (c) => c.query("update public.contacts set organization_id = $1 where id = $2", [orgA, rows[0].id])));
      expect(err.code).toBe("42501");
    });
  });

  describe("agent_executions", () => {
    let executionA = "";

    it("a writer can insert a queued execution for its own org as itself", async () => {
      const { rows } = await asUser(userA, (c) =>
        c.query<{ id: string }>(
          "insert into public.agent_executions (organization_id, agent_slug, user_id, status) values ($1, 'data-analytics-agent', $2, 'queued') returning id",
          [orgA, userA],
        ),
      );
      executionA = rows[0].id;
      expect(executionA).toBeTruthy();
    });

    it("rejects inserts that are not queued, for another user, or for another org", async () => {
      const notQueued = await pgError(
        asUser(userA, (c) =>
          c.query("insert into public.agent_executions (organization_id, agent_slug, user_id, status) values ($1, 'data-analytics-agent', $2, 'succeeded')", [orgA, userA]),
        ),
      );
      expect(notQueued.code).toBe("42501");
      expect(notQueued.message).toMatch(/row-level security/);

      const otherUser = await pgError(
        asUser(userA, (c) =>
          c.query("insert into public.agent_executions (organization_id, agent_slug, user_id, status) values ($1, 'data-analytics-agent', $2, 'queued')", [orgA, userB]),
        ),
      );
      expect(otherUser.code).toBe("42501");

      const otherOrg = await pgError(
        asUser(userA, (c) =>
          c.query("insert into public.agent_executions (organization_id, agent_slug, user_id, status) values ($1, 'data-analytics-agent', $2, 'queued')", [orgB, userA]),
        ),
      );
      expect(otherOrg.code).toBe("42501");
    });

    it("user B cannot read A's executions", async () => {
      const res = await asUser(userB, (c) => c.query("select id from public.agent_executions where id = $1 or organization_id = $2", [executionA, orgA]));
      expect(res.rowCount).toBe(0);
    });

    it("authenticated users cannot change execution status (server-only)", async () => {
      const res = await asUser(userA, (c) => c.query("update public.agent_executions set status = 'succeeded' where id = $1", [executionA]));
      expect(res.rowCount).toBe(0);
      const check = await db.query("select status from public.agent_executions where id = $1", [executionA]);
      expect(check.rows).toEqual([{ status: "queued" }]);
    });

    it("callback_token_hash is not selectable by authenticated, but id is", async () => {
      await db.query("update public.agent_executions set callback_token_hash = 'deadbeef' where id = $1", [executionA]);
      const err = await pgError(asUser(userA, (c) => c.query("select callback_token_hash from public.agent_executions where id = $1", [executionA])));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/permission denied/);
      const star = await pgError(asUser(userA, (c) => c.query("select * from public.agent_executions where id = $1", [executionA])));
      expect(star.code).toBe("42501");
      const ok = await asUser(userA, (c) => c.query("select id, status from public.agent_executions where id = $1", [executionA]));
      expect(ok.rows).toEqual([{ id: executionA, status: "queued" }]);
    });
  });

  describe("server-only tables", () => {
    it("integration_secrets is not readable at all by authenticated", async () => {
      const integ = await db.query<{ id: string }>("select id from public.integrations where organization_id = $1 and provider = 'gmail'", [orgA]);
      await asService((c) =>
        c.query("insert into public.integration_secrets (integration_id, organization_id, ciphertext, iv, auth_tag) values ($1, $2, 'ct', 'iv', 'tag')", [integ.rows[0].id, orgA]),
      );
      const err = await pgError(asUser(userA, (c) => c.query("select * from public.integration_secrets")));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/permission denied for table integration_secrets/);
      const count = await pgError(asUser(userA, (c) => c.query("select count(*) from public.integration_secrets")));
      expect(count.code).toBe("42501");
      const write = await pgError(asUser(userA, (c) => c.query("delete from public.integration_secrets where organization_id = $1", [orgA])));
      expect(write.code).toBe("42501");
    });

    it("audit_logs cannot be inserted by authenticated", async () => {
      const err = await pgError(asUser(userA, (c) => c.query("insert into public.audit_logs (organization_id, actor_id, action) values ($1, $2, 'forged')", [orgA, userA])));
      expect(err.code).toBe("42501");
      expect(err.message).toMatch(/permission denied for table audit_logs/);
    });

    it("integrations metadata cannot be changed by authenticated", async () => {
      const res = await asUser(userA, (c) => c.query("update public.integrations set status = 'connected' where organization_id = $1", [orgA]));
      expect(res.rowCount).toBe(0);
    });
  });

  describe("viewer role", () => {
    it("a viewer of org A can read A's contacts", async () => {
      const { rows } = await asUser(viewer, (c) => c.query("select id from public.contacts where id = $1", [contactA]));
      expect(rows).toEqual([{ id: contactA }]);
    });

    it("a viewer cannot insert, update or delete", async () => {
      const ins = await pgError(asUser(viewer, (c) => c.query("insert into public.contacts (organization_id, name) values ($1, 'Viewer insert')", [orgA])));
      expect(ins.code).toBe("42501");
      expect(ins.message).toMatch(/row-level security/);
      const upd = await asUser(viewer, (c) => c.query("update public.contacts set name = 'Viewer edit' where id = $1", [contactA]));
      expect(upd.rowCount).toBe(0);
      const del = await asUser(viewer, (c) => c.query("delete from public.contacts where id = $1", [contactA]));
      expect(del.rowCount).toBe(0);
      const check = await db.query("select name from public.contacts where id = $1", [contactA]);
      expect(check.rows).toEqual([{ name: "Alice Customer" }]);
    });

    it("a viewer cannot promote itself", async () => {
      const res = await asUser(viewer, (c) => c.query("update public.organization_members set role = 'owner' where organization_id = $1 and user_id = $2", [orgA, viewer]));
      expect(res.rowCount).toBe(0);
    });
  });

  describe("deals", () => {
    it("cannot reference a contact from another org, even via service_role (composite FK)", async () => {
      const err = await pgError(asService((c) => c.query("insert into public.deals (organization_id, contact_id, title) values ($1, $2, 'Cross-org deal')", [orgB, contactA])));
      expect(err.code).toBe("23503");
      expect(err.message).toMatch(/foreign key/);
    });

    it("deleting a contact keeps its deals with contact_id = null", async () => {
      const contact = await asUser(userA, (c) => c.query<{ id: string }>("insert into public.contacts (organization_id, name) values ($1, 'Short-lived') returning id", [orgA]));
      const contactId = contact.rows[0].id;
      const deal = await asUser(userA, (c) =>
        c.query<{ id: string }>("insert into public.deals (organization_id, contact_id, title, value) values ($1, $2, 'Keep me', 1000) returning id", [orgA, contactId]),
      );
      const dealId = deal.rows[0].id;
      const del = await asUser(userA, (c) => c.query("delete from public.contacts where id = $1", [contactId]));
      expect(del.rowCount).toBe(1);
      const { rows } = await asUser(userA, (c) => c.query("select id, contact_id, title from public.deals where id = $1", [dealId]));
      expect(rows).toEqual([{ id: dealId, contact_id: null, title: "Keep me" }]);
    });
  });
});
