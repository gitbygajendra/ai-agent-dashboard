"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/utils";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setLoading(true);
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await api<{ needsConfirmation?: boolean }>(`/api/auth/${mode}`, { method: "POST", json: data });
      if (res.needsConfirmation) {
        setNotice("Check your email to confirm your account, then sign in.");
        return;
      }
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
      router.refresh();
    } catch (err) {
      const e2 = err as Error & { details?: { path: string; message: string }[] };
      if (Array.isArray(e2.details)) setFieldErrors(Object.fromEntries(e2.details.map((d) => [d.path, d.message])));
      setError(e2.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {mode === "signup" && (
        <>
          <Field label="Your name" error={fieldErrors.full_name}>
            <Input name="full_name" autoComplete="name" required />
          </Field>
          <Field label="Business name" hint="Your workspace. You can rename it later." error={fieldErrors.organization_name}>
            <Input name="organization_name" autoComplete="organization" required />
          </Field>
        </>
      )}
      <Field label="Email" error={fieldErrors.email}>
        <Input name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined} error={fieldErrors.password}>
        <Input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={8} />
      </Field>
      <Button type="submit" className="w-full" loading={loading}>
        {mode === "login" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {mode === "login" ? (
          <>
            New here? <Link className="text-primary hover:underline" href="/signup">Create an account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="text-primary hover:underline" href="/login">Sign in</Link>
          </>
        )}
      </p>
    </form>
  );
}
