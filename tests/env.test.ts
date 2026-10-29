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
});
