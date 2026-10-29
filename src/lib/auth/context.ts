import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { withUser } from "../db";
import { Errors } from "../errors";
import { getSessionUser, type SessionUser } from "./session";

export type Role = "owner" | "admin" | "member" | "viewer";

export type OrgContext = {
  user: SessionUser;
  fullName: string | null;
  orgId: string;
  orgName: string;
  currency: string;
  role: Role;
};

/**
 * Resolves the signed-in user's active organization and role. The membership
 * lookup runs under RLS, so a user can only ever resolve organizations they
 * belong to.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const row = await withUser(user.id, (tx) =>
    tx.one<{ org_id: string; name: string; currency: string; role: Role; full_name: string | null }>(
      `select o.id as org_id, o.name, o.currency, m.role, p.full_name
         from public.organization_members m
         join public.organizations o on o.id = m.organization_id
         left join public.profiles p on p.id = m.user_id
        where m.user_id = auth.uid()
        order by (o.id = p.default_organization_id) desc nulls last, m.created_at asc
        limit 1`,
    ),
  );
  if (!row) return null;
  return {
    user,
    fullName: row.full_name,
    orgId: row.org_id,
    orgName: row.name,
    currency: row.currency,
    role: row.role,
  };
});

/** For route handlers: throws 401 when signed out. */
export async function requireOrgContext(): Promise<OrgContext> {
  const ctx = await getOrgContext();
  if (!ctx) throw Errors.unauthorized();
  return ctx;
}

/** For server components: redirects to the sign-in page when signed out. */
export async function requirePageContext(): Promise<OrgContext> {
  const ctx = await getOrgContext();
  // The proxy only lets requests with a session cookie reach pages, so landing
  // here means the cookie is stale (invalid, user deleted, database reset).
  // Redirecting straight to /login would bounce back to /dashboard forever.
  if (!ctx) redirect("/api/auth/logout");
  return ctx;
}

export function canWrite(ctx: OrgContext) {
  return ctx.role === "owner" || ctx.role === "admin" || ctx.role === "member";
}

export function isAdmin(ctx: OrgContext) {
  return ctx.role === "owner" || ctx.role === "admin";
}

export function assertCanWrite(ctx: OrgContext) {
  if (!canWrite(ctx)) throw Errors.forbidden("Viewers can't make changes. Ask an admin for member access.");
}

export function assertAdmin(ctx: OrgContext) {
  if (!isAdmin(ctx)) throw Errors.forbidden("Only workspace owners and admins can do that.");
}
