import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertAdmin, requireOrgContext } from "@/lib/auth/context";
import { randomToken } from "@/lib/crypto";
import { AppError, handler } from "@/lib/errors";
import { buildAuthUrl, gmailConfigured, signState } from "@/lib/integrations/gmail";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/** Starts the Google OAuth flow. Admins only. */
export const GET = handler(async () => {
  const ctx = await requireOrgContext();
  assertAdmin(ctx);
  if (!gmailConfigured()) {
    throw new AppError("GMAIL_NOT_CONFIGURED", "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ENCRYPTION_KEY on the server first.", 400);
  }
  const nonce = randomToken(16);
  (await cookies()).set("gmail_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/api/integrations/gmail",
    maxAge: 600,
  });
  return NextResponse.redirect(buildAuthUrl(signState({ orgId: ctx.orgId, userId: ctx.user.id, nonce })));
});
