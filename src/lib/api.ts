import "server-only";
import { NextResponse } from "next/server";
import { requireOrgContext, type OrgContext } from "./auth/context";
import { Errors } from "./errors";
import { rateLimit } from "./rate-limit";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, headers: { "cache-control": "no-store", ...(init?.headers ?? {}) } });
}

/** Reject cross-site state-changing requests (defense in depth on top of SameSite cookies). */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients and same-origin navigations
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw Errors.forbidden("Cross-site request blocked.");
  } catch (err) {
    if (err instanceof Error && err.name === "AppError") throw err;
    throw Errors.forbidden("Cross-site request blocked.");
  }
}

/** Authenticate, enforce same-origin for writes, and apply a per-user request budget. */
export async function apiContext(req: Request): Promise<OrgContext> {
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
  const ctx = await requireOrgContext();
  const rl = rateLimit(`api:${ctx.user.id}`, 300, 60_000);
  if (!rl.ok) throw Errors.rateLimited(rl.retryAfterSec);
  return ctx;
}

export function searchParams(req: Request) {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}
