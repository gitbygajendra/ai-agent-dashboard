import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { withService } from "../db";
import { env } from "../env";
import { LOCAL_SESSION_COOKIE, verifySessionToken } from "./local-session";

export type SessionUser = { id: string; email: string | null };

const globalForUser = globalThis as unknown as { __agentDashLocalUser?: Promise<SessionUser> };

/** AUTH_MODE=none: everyone using this computer is the same owner. The signup trigger creates the workspace. */
function localUser(): Promise<SessionUser> {
  globalForUser.__agentDashLocalUser ??= withService(async (tx) => {
    const existing = await tx.one<SessionUser>("select id, email from auth.users order by created_at limit 1");
    if (existing) return existing;
    return (await tx.one<SessionUser>(
      "insert into auth.users (email, raw_user_meta_data) values ('owner@localhost', $1) returning id, email",
      [JSON.stringify({ full_name: "Owner", organization_name: "My Workspace" })],
    ))!;
  }).catch((err) => {
    globalForUser.__agentDashLocalUser = undefined;
    throw err;
  });
  return globalForUser.__agentDashLocalUser;
}

export async function supabaseServerClient() {
  const e = env();
  const store = await cookies();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // The proxy refreshes the session cookie on the next request.
        }
      },
    },
  });
}

/**
 * Returns the signed-in user, verified server-side:
 *  - supabase mode: `auth.getUser()` validates the access token with Supabase Auth.
 *  - local mode: HMAC-verified session cookie.
 *  - none mode: the one local user (created on first use), no sign-in.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const e = env();
  if (e.AUTH_MODE === "none") return localUser();
  if (e.AUTH_MODE === "supabase") {
    const supabase = await supabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }
  const store = await cookies();
  const payload = verifySessionToken(store.get(LOCAL_SESSION_COOKIE)?.value, e.LOCAL_AUTH_SECRET!);
  return payload ? { id: payload.sub, email: payload.email } : null;
});
