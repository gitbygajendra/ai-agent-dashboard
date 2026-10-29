import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { audit } from "../audit";
import { withService } from "../db";
import { env } from "../env";
import { AppError, Errors } from "../errors";
import { rateLimit } from "../rate-limit";
import { createSessionToken, LOCAL_SESSION_COOKIE, LOCAL_SESSION_TTL_SEC } from "./local-session";
import { supabaseServerClient } from "./session";

export const credentialsSchema = z.object({
  email: z.email("Enter a valid email.").max(320).transform((v) => v.toLowerCase()),
  password: z.string().min(8, "Use at least 8 characters.").max(200),
});

export const signupSchema = credentialsSchema.extend({
  full_name: z.string().trim().min(1, "Enter your name.").max(120),
  organization_name: z.string().trim().min(1, "Enter a workspace name.").max(120),
});

function limit(key: string) {
  const rl = rateLimit(key, 10, 10 * 60_000);
  if (!rl.ok) throw Errors.rateLimited(rl.retryAfterSec);
}

async function setLocalSession(user: { id: string; email: string }) {
  const store = await cookies();
  store.set(LOCAL_SESSION_COOKIE, createSessionToken({ sub: user.id, email: user.email }, env().LOCAL_AUTH_SECRET!), {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: LOCAL_SESSION_TTL_SEC,
  });
}

const INVALID = () => new AppError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401);

export async function signIn(raw: unknown, ip: string) {
  const { email, password } = credentialsSchema.parse(raw);
  limit(`login:${ip}:${email}`);
  const e = env();
  if (e.AUTH_MODE === "supabase") {
    const supabase = await supabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw INVALID();
    await audit({ orgId: null, actorId: data.user.id, action: "auth.sign_in" });
    return;
  }
  const user = await withService((tx) =>
    tx.one<{ id: string; email: string }>(
      "select id, email from auth.users where lower(email) = $1 and encrypted_password = crypt($2, encrypted_password)",
      [email, password],
    ),
  );
  if (!user) throw INVALID();
  await setLocalSession(user);
  await audit({ orgId: null, actorId: user.id, action: "auth.sign_in" });
}

export async function signUp(raw: unknown, ip: string): Promise<{ needsConfirmation: boolean }> {
  const input = signupSchema.parse(raw);
  limit(`signup:${ip}`);
  const e = env();
  const meta = { full_name: input.full_name, organization_name: input.organization_name };
  if (e.AUTH_MODE === "supabase") {
    const supabase = await supabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: { data: meta, emailRedirectTo: `${e.APP_BASE_URL}/dashboard` },
    });
    if (error) throw new AppError("SIGNUP_FAILED", error.message, 400);
    return { needsConfirmation: !data.session };
  }
  const user = await withService(async (tx) => {
    const exists = await tx.one("select 1 from auth.users where lower(email) = $1", [input.email]);
    if (exists) throw Errors.conflict("An account with this email already exists. Sign in instead.");
    return tx.one<{ id: string; email: string }>(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data)
       values ($1, crypt($2, gen_salt('bf', 10)), $3) returning id, email`,
      [input.email, input.password, JSON.stringify(meta)],
    );
  });
  await setLocalSession(user!);
  await audit({ orgId: null, actorId: user!.id, action: "auth.sign_up" });
  return { needsConfirmation: false };
}

export async function signOut() {
  if (env().AUTH_MODE === "supabase") {
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
    return;
  }
  (await cookies()).delete(LOCAL_SESSION_COOKIE);
}
