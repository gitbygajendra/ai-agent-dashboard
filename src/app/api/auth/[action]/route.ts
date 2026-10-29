import { NextResponse } from "next/server";
import { assertSameOrigin, json } from "@/lib/api";
import { signIn, signOut, signUp } from "@/lib/auth/actions";
import { readJson } from "@/lib/agents/handlers/shared";
import { Errors, handler } from "@/lib/errors";

export const runtime = "nodejs";

/** GET /api/auth/logout: clears a session whose user no longer resolves (deleted user, reset database) and returns to sign-in. */
export const GET = handler(async (req: Request, { params }: { params: Promise<{ action: string }> }) => {
  const { action } = await params;
  if (action !== "logout") throw Errors.notFound("Action");
  await signOut();
  return NextResponse.redirect(new URL("/login", req.url));
});

export const POST = handler(async (req: Request, { params }: { params: Promise<{ action: string }> }) => {
  const { action } = await params;
  assertSameOrigin(req);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  switch (action) {
    case "login":
      await signIn(await readJson(req, 5000), ip);
      return json({ ok: true });
    case "signup":
      return json(await signUp(await readJson(req, 5000), ip));
    case "logout":
      await signOut();
      return json({ ok: true });
    default:
      throw Errors.notFound("Action");
  }
});
