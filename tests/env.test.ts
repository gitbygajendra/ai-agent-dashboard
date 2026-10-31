import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/lib/env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("env", () => {
  it("treats blank values copied from .env.example as unset", () => {
    process.env = {
      ...saved,
      DATABASE_URL: "postgres://x@localhost/db",
      AUTH_MODE: "local",
      LOCAL_AUTH_SECRET: "x".repeat(40),
      N8N_MASTER_WEBHOOK_URL: "",
      N8N_WEBHOOK_URL_DATA_ANALYTICS: "  ",
      NODE_ENV: "test",
    };
    resetEnvCache();
    const e = env();
    expect(e.N8N_MASTER_WEBHOOK_URL).toBeUndefined();
    expect(e.N8N_WEBHOOK_URL_DATA_ANALYTICS).toBeUndefined();
    expect(e.N8N_WORKFLOW_MODE).toBe("master");
  });

  it("with nothing configured runs standalone: embedded database, built-in engine, no sign-in", () => {
    const clean = Object.fromEntries(Object.entries(saved).filter(([k]) => !/^(DATABASE_URL|AUTH_MODE|N8N_|NEXT_PUBLIC_SUPABASE|AI_PROVIDER|GROQ_API_KEY|ANTHROPIC_API_KEY)/.test(k)));
    process.env = { ...clean, NODE_ENV: "test" };
    resetEnvCache();
    const e = env();
    expect(e.DATABASE_URL).toBeUndefined();
    expect(e.AUTH_MODE).toBe("none");
    expect(e.ENGINE).toBe("builtin");
    expect(e.AI_PROVIDER).toBe("anthropic");

    process.env = { ...clean, NODE_ENV: "test", GROQ_API_KEY: "gsk_test" };
    resetEnvCache();
    expect(env()).toMatchObject({ AI_PROVIDER: "groq", AI_MODEL: "llama-3.3-70b-versatile" });

    process.env = { ...clean, NODE_ENV: "production" };
    resetEnvCache();
    expect(() => env()).toThrow(/no sign-in/);
  });

  it("uses n8n when N8N_BASE_URL is set", () => {
    process.env = { ...saved, DATABASE_URL: "postgres://x@localhost/db", AUTH_MODE: "local", LOCAL_AUTH_SECRET: "x".repeat(40), N8N_BASE_URL: "http://localhost:5678", NODE_ENV: "test" };
    resetEnvCache();
    expect(env().ENGINE).toBe("n8n");
  });
});
