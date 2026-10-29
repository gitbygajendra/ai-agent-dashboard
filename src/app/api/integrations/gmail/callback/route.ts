import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireOrgContext } from "@/lib/auth/context";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { connectWithCode, verifyState } from "@/lib/integrations/gmail";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const base = env().APP_BASE_URL.replace(/\/+$/, "");
  const back = (status: string) => NextResponse.redirect(`${base}/integrations?gmail=${status}`);
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("error")) return back("denied");
    const ctx = await requireOrgContext();
    const state = verifyState(url.searchParams.get("state"));
    const store = await cookies();
    const nonce = store.get("gmail_oauth_nonce")?.value;
    store.delete("gmail_oauth_nonce");
    if (!state || !nonce || !safeEqual(state.nonce, nonce) || state.orgId !== ctx.orgId || state.userId !== ctx.user.id) {
      return back("invalid_state");
    }
    const code = url.searchParams.get("code");
    if (!code) return back("missing_code");
    await connectWithCode(ctx.orgId, ctx.user.id, code);
    await audit({ orgId: ctx.orgId, actorId: ctx.user.id, action: "integration.connected", entityType: "integration", entityId: "gmail" });
    return back("connected");
  } catch (err) {
    logger.error("gmail_oauth_callback_failed", { error: (err as Error).message });
    return back("error");
  }
}
