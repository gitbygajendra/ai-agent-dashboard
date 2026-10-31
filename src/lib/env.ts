import "server-only";
import { z } from "zod";

/**
 * Server-side configuration. Read lazily so that `next build` works without
 * secrets, and validated on first use so misconfiguration fails loudly.
 * Nothing in this module may be imported by client components.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),

  // Unset: an embedded database (PGlite) in .data/db, nothing to install.
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),

  // "none": no sign-in, one automatic local user (default when DATABASE_URL is unset).
  AUTH_MODE: z.enum(["supabase", "local", "none"]).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("agent-files"),
  LOCAL_AUTH_SECRET: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().default(".data/uploads"),

  ENCRYPTION_KEY: z.string().optional(),

  N8N_BASE_URL: z.url().optional(),
  // "master": one n8n workflow handles every agent at ${N8N_BASE_URL}/webhook/agent-dashboard.
  // "per-agent": one workflow per agent at ${N8N_BASE_URL}/webhook/<agent-slug>.
  N8N_WORKFLOW_MODE: z.enum(["master", "per-agent"]).default("master"),
  N8N_MASTER_WEBHOOK_URL: z.url().optional(),
  N8N_WEBHOOK_SECRET: z.string().optional(),
  N8N_API_KEY: z.string().optional(),
  N8N_ACK_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  N8N_WEBHOOK_URL_DATA_ANALYTICS: z.url().optional(),
  N8N_WEBHOOK_URL_EMAIL_AUTOMATION: z.url().optional(),
  N8N_WEBHOOK_URL_FINANCE_AUDIT: z.url().optional(),
  N8N_WEBHOOK_URL_CRM_AUTOMATION: z.url().optional(),
  N8N_WEBHOOK_URL_DATA_ADVISORY: z.url().optional(),
  N8N_WEBHOOK_URL_CUSTOMER_SUPPORT: z.url().optional(),
  N8N_WEBHOOK_URL_LEAD_GENERATION: z.url().optional(),

  // Default: groq when GROQ_API_KEY is set, else anthropic.
  AI_PROVIDER: z.enum(["anthropic", "groq"]).optional(),
  // Used by the built-in engine (no n8n). With n8n, the key lives in n8n instead.
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Defaults per provider: claude-opus-5-5 (anthropic), llama-3.3-70b-versatile (groq).
  AI_MODEL: z.string().optional(),
  AI_ENABLED: z.enum(["true", "false"]).default("true"),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  AGENT_RUNS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_DATASET_ROWS: z.coerce.number().int().positive().default(50000),
});

type AiProvider = "anthropic" | "groq";

export type Env = Omit<z.infer<typeof schema>, "AI_PROVIDER"> & {
  AI_PROVIDER: AiProvider;
  AI_MODEL: string;
  /** "builtin": agents run inside the app (no n8n configured). */
  ENGINE: "n8n" | "builtin";
};

export const DEFAULT_AI_MODEL: Record<AiProvider, string> = { anthropic: "claude-opus-5-5", groq: "llama-3.3-70b-versatile" };

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // Treat blank values (e.g. `FOO=` copied from .env.example) as unset.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  const d = parsed.data;
  const provider: AiProvider = d.AI_PROVIDER ?? (d.GROQ_API_KEY ? "groq" : "anthropic");
  const n8nConfigured = Boolean(d.N8N_BASE_URL || d.N8N_MASTER_WEBHOOK_URL) || Object.entries(d).some(([k, v]) => k.startsWith("N8N_WEBHOOK_URL_") && v);
  const e: Env = { ...d, AI_PROVIDER: provider, AI_MODEL: d.AI_MODEL ?? DEFAULT_AI_MODEL[provider], ENGINE: n8nConfigured ? "n8n" : "builtin" };
  if (!e.AUTH_MODE) {
    e.AUTH_MODE = !e.DATABASE_URL ? "none" : e.NEXT_PUBLIC_SUPABASE_URL && e.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "supabase" : "local";
  }
  if (e.AUTH_MODE === "none" && e.NODE_ENV === "production" && process.env.ALLOW_LOCAL_AUTH !== "true") {
    throw new Error("AUTH_MODE=none (no sign-in) is for running on your own computer only. Configure AUTH_MODE=local or supabase for production.");
  }
  if (!e.DATABASE_URL && e.AUTH_MODE !== "none") {
    throw new Error("The embedded database (no DATABASE_URL) only supports AUTH_MODE=none.");
  }
  if (e.AUTH_MODE === "local") {
    if (e.NODE_ENV === "production" && process.env.ALLOW_LOCAL_AUTH !== "true") {
      throw new Error("AUTH_MODE=local is for development. Configure Supabase Auth for production.");
    }
    if (!e.LOCAL_AUTH_SECRET || e.LOCAL_AUTH_SECRET.length < 32) {
      throw new Error("LOCAL_AUTH_SECRET must be set (32+ characters) when AUTH_MODE=local");
    }
  }
  if (e.AUTH_MODE === "supabase" && (!e.NEXT_PUBLIC_SUPABASE_URL || !e.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required when AUTH_MODE=supabase");
  }
  cached = e;
  return e;
}

/** For tests only. */
export function resetEnvCache() {
  cached = null;
}
