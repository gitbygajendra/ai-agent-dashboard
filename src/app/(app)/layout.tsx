import { AppShell } from "@/components/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { env } from "@/lib/env";

// Every page here is per-user: never prerender at build time.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageContext();
  return (
    <AppShell orgName={ctx.orgName} userLabel={ctx.fullName ?? ctx.user.email ?? "You"} role={ctx.role} authMode={env().AUTH_MODE!}>
      {children}
    </AppShell>
  );
}
