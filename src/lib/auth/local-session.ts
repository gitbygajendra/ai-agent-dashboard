import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed session cookie for AUTH_MODE=local (development without a Supabase
 * project). Format: base64url(payload).base64url(HMAC-SHA256(payload)).
 */
export const LOCAL_SESSION_COOKIE = "ad_session";
export const LOCAL_SESSION_TTL_SEC = 60 * 60 * 24 * 7;

export type LocalSessionPayload = { sub: string; email: string; exp: number };

function sign(data: string, secret: string) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(
  payload: Omit<LocalSessionPayload, "exp">,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowSec + LOCAL_SESSION_TTL_SEC })).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): LocalSessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LocalSessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}
