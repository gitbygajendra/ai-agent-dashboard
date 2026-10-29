import "server-only";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Private file storage. Every object key is prefixed with the organization id
 * and only the server reads or writes objects.
 *  - Supabase Storage (private bucket) when SUPABASE_SERVICE_ROLE_KEY is set.
 *  - Local disk (LOCAL_STORAGE_DIR) otherwise, for development.
 */
export type StoredObject = { path: string; size: number; contentType: string };

function supabaseAdmin() {
  const e = env();
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL!, e.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function supabaseStorageEnabled() {
  const e = env();
  return Boolean(e.NEXT_PUBLIC_SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

export function objectKey(orgId: string, folder: string, fileName: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${orgId}/${folder}/${stamp}/${crypto.randomUUID()}-${safeName(fileName)}`;
}

function localPath(key: string) {
  // Local-disk storage is a development fallback; keep it out of output file tracing.
  const root = path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().LOCAL_STORAGE_DIR);
  const full = path.resolve(/*turbopackIgnore: true*/ root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("invalid storage key");
  return full;
}

export async function putObject(key: string, data: Buffer, contentType: string): Promise<StoredObject> {
  if (supabaseStorageEnabled()) {
    const { error } = await supabaseAdmin().storage.from(env().SUPABASE_STORAGE_BUCKET).upload(key, data, {
      contentType,
      upsert: false,
    });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
  } else {
    const full = localPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  }
  return { path: key, size: data.length, contentType };
}

export async function getObject(key: string, orgId: string): Promise<Buffer> {
  if (!key.startsWith(`${orgId}/`)) throw new Error("storage key does not belong to organization");
  if (supabaseStorageEnabled()) {
    const { data, error } = await supabaseAdmin().storage.from(env().SUPABASE_STORAGE_BUCKET).download(key);
    if (error || !data) throw new Error(`storage download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  return readFile(localPath(key));
}

export async function deleteObject(key: string, orgId: string): Promise<void> {
  if (!key.startsWith(`${orgId}/`)) throw new Error("storage key does not belong to organization");
  if (supabaseStorageEnabled()) {
    await supabaseAdmin().storage.from(env().SUPABASE_STORAGE_BUCKET).remove([key]);
  } else {
    await rm(localPath(key), { force: true });
  }
}

/** Short-lived download link (Supabase only); local mode streams via an API route instead. */
export async function signedUrl(key: string, orgId: string, expiresInSec = 300): Promise<string | null> {
  if (!key.startsWith(`${orgId}/`) || !supabaseStorageEnabled()) return null;
  const { data } = await supabaseAdmin().storage.from(env().SUPABASE_STORAGE_BUCKET).createSignedUrl(key, expiresInSec);
  return data?.signedUrl ?? null;
}
