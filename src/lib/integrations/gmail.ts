import "server-only";
import { createHmac } from "node:crypto";
import { seal, unseal, safeEqual } from "../crypto";
import { withService } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import { logger } from "../logger";
import type { EmailMessage } from "../agents/logic/email";

/**
 * Gmail via Google OAuth 2.0 (authorization code flow, offline access).
 * Tokens are encrypted with ENCRYPTION_KEY and stored in integration_secrets,
 * which only the server can read. They are never sent to the browser or to n8n.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

type TokenSet = { access_token: string; refresh_token?: string; expires_at: number; scope?: string };

export function gmailConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.ENCRYPTION_KEY);
}

function redirectUri() {
  return `${env().APP_BASE_URL.replace(/\/+$/, "")}/api/integrations/gmail/callback`;
}

function stateSecret() {
  const e = env();
  return e.ENCRYPTION_KEY ?? e.LOCAL_AUTH_SECRET ?? "";
}

/** Signed OAuth state binding the flow to an org, user and nonce cookie. */
export function signState(payload: { orgId: string; userId: string; nonce: string }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(state: string | null): { orgId: string; userId: string; nonce: string } | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { orgId: string; userId: string; nonce: string; exp: number };
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const e = env();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.GOOGLE_CLIENT_ID!, client_secret: e.GOOGLE_CLIENT_SECRET!, ...params }),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new AppError("GMAIL_TOKEN_ERROR", `Google rejected the token request (${data.error ?? res.status}).`, 502);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
    scope: data.scope,
  };
}

export async function connectWithCode(orgId: string, userId: string, code: string) {
  const tokens = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!tokens.refresh_token) {
    throw new AppError("GMAIL_NO_REFRESH_TOKEN", "Google did not return offline access. Remove the app from your Google account permissions and connect again.", 400);
  }
  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  }).then((r) => r.json() as Promise<{ emailAddress?: string }>);
  await saveTokens(orgId, tokens, { userId, account: profile.emailAddress ?? null });
}

async function saveTokens(orgId: string, tokens: TokenSet, meta?: { userId: string; account: string | null }) {
  const sealed = seal(JSON.stringify(tokens), env().ENCRYPTION_KEY!);
  await withService(async (tx) => {
    const integ = await tx.one<{ id: string }>(
      `update public.integrations
          set status = 'connected', last_error = null, last_checked_at = now(),
              scopes = $2, account_label = coalesce($3, account_label), connected_by = coalesce($4, connected_by)
        where organization_id = $1 and provider = 'gmail'
        returning id`,
      [orgId, (tokens.scope ?? SCOPES.join(" ")).split(" "), meta?.account ?? null, meta?.userId ?? null],
    );
    if (!integ) throw new Error("gmail integration row missing");
    await tx.query(
      `insert into public.integration_secrets (integration_id, organization_id, ciphertext, iv, auth_tag)
       values ($1, $2, $3, $4, $5)
       on conflict (integration_id) do update set ciphertext = excluded.ciphertext, iv = excluded.iv,
         auth_tag = excluded.auth_tag, updated_at = now()`,
      [integ.id, orgId, sealed.ciphertext, sealed.iv, sealed.authTag],
    );
  });
}

export async function disconnectGmail(orgId: string) {
  await withService(async (tx) => {
    const integ = await tx.one<{ id: string }>(
      `update public.integrations set status = 'not_connected', account_label = null, scopes = '{}', last_error = null
        where organization_id = $1 and provider = 'gmail' returning id`,
      [orgId],
    );
    if (integ) await tx.query("delete from public.integration_secrets where integration_id = $1", [integ.id]);
  });
}

async function markNeedsAttention(orgId: string, message: string) {
  await withService((tx) =>
    tx.query("update public.integrations set status = 'needs_attention', last_error = $2, last_checked_at = now() where organization_id = $1 and provider = 'gmail'", [orgId, message]),
  );
}

async function accessToken(orgId: string): Promise<string> {
  if (!gmailConfigured()) throw new AppError("GMAIL_NOT_CONFIGURED", "Gmail is not set up on this server (Google OAuth credentials missing).", 400);
  const row = await withService((tx) =>
    tx.one<{ ciphertext: string; iv: string; auth_tag: string; status: string }>(
      `select s.ciphertext, s.iv, s.auth_tag, i.status from public.integrations i
         join public.integration_secrets s on s.integration_id = i.id
        where i.organization_id = $1 and i.provider = 'gmail'`,
      [orgId],
    ),
  );
  if (!row) throw new AppError("GMAIL_NOT_CONNECTED", "Connect Gmail on the Integrations page first.", 400);
  const tokens = JSON.parse(unseal({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag }, env().ENCRYPTION_KEY!)) as TokenSet;
  if (tokens.expires_at > Date.now()) return tokens.access_token;
  try {
    const refreshed = await tokenRequest({ refresh_token: tokens.refresh_token!, grant_type: "refresh_token" });
    await saveTokens(orgId, { ...refreshed, refresh_token: refreshed.refresh_token ?? tokens.refresh_token });
    return refreshed.access_token;
  } catch (err) {
    await markNeedsAttention(orgId, "Google access expired or was revoked. Reconnect Gmail.");
    throw err;
  }
}

async function gmail<T>(orgId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken(orgId);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) {
    await markNeedsAttention(orgId, `Gmail returned HTTP ${res.status}. Reconnect Gmail.`);
    throw new AppError("GMAIL_FORBIDDEN", "Gmail access was denied. Reconnect Gmail on the Integrations page.", 502);
  }
  if (!res.ok) throw new AppError("GMAIL_ERROR", `Gmail API error (HTTP ${res.status}).`, 502);
  return res.json() as Promise<T>;
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };

function decodeBody(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = decodeBody(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

/** Recent inbox messages that probably need attention (default: unanswered, last 7 days). */
export async function listInbox(orgId: string, query = "in:inbox newer_than:7d -category:promotions -from:me", max = 15): Promise<EmailMessage[]> {
  const list = await gmail<{ messages?: { id: string; threadId: string }[] }>(orgId, `messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(max, 25)) })}`);
  const out: EmailMessage[] = [];
  for (const m of list.messages ?? []) {
    const msg = await gmail<{ id: string; threadId: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } }>(orgId, `messages/${m.id}?format=full`);
    const header = (n: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    out.push({
      id: msg.id,
      thread_id: msg.threadId,
      from: header("from"),
      to: header("to"),
      subject: header("subject"),
      date: header("date"),
      body: decodeBody(msg.payload).slice(0, 10000),
      source: "gmail",
    });
  }
  logger.info("gmail_inbox_listed", { org_id: orgId, count: out.length });
  return out;
}

function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export async function sendEmail(orgId: string, msg: { to: string; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null }) {
  if (/[\r\n]/.test(msg.to) || /[\r\n]/.test(msg.subject)) throw new AppError("INVALID_HEADER", "Invalid recipient or subject.", 400);
  const lines = [
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`, `References: ${msg.inReplyTo}`] : []),
    "",
    msg.body,
  ];
  const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
  return gmail<{ id: string }>(orgId, "messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) }),
  });
}
