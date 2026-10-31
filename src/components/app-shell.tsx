"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, BarChart3, Bot, ChevronDown, LayoutDashboard, LogOut, Menu, Plug, Settings, Users, X } from "lucide-react";
import { AGENT_SLUGS, AGENTS } from "@/lib/agents/registry";
import { AgentIcon } from "./status";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/agents", label: "AI Agents", icon: Bot, children: true },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/crm", label: "CRM", icon: Users },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/runs", label: "Workflow Runs", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [agentsOpen, setAgentsOpen] = useState(true);
  return (
    <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <div key={item.href}>
            <div className="flex items-center">
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  active ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
              {item.children && (
                <button
                  type="button"
                  onClick={() => setAgentsOpen((v) => !v)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
                  aria-label={agentsOpen ? "Collapse agents" : "Expand agents"}
                  aria-expanded={agentsOpen}
                >
                  <ChevronDown className={cn("size-4 transition-transform", !agentsOpen && "-rotate-90")} />
                </button>
              )}
            </div>
            {item.children && agentsOpen && (
              <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l pl-2">
                {AGENT_SLUGS.map((slug) => {
                  const href = `/agents/${slug}`;
                  const a = pathname === href;
                  return (
                    <Link
                      key={slug}
                      href={href}
                      onClick={onNavigate}
                      aria-current={a ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                        a ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <AgentIcon icon={AGENTS[slug].icon} className="size-5 rounded [&_svg]:size-3" />
                      <span className="truncate">{AGENTS[slug].name.replace(" Agent", "")}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2 px-5 py-4">
      <span className="inline-flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Bot className="size-4" />
      </span>
      <span className="text-sm font-semibold">Agent Workspace</span>
    </Link>
  );
}

export function AppShell({
  children,
  orgName,
  userLabel,
  role,
  authMode,
}: {
  children: React.ReactNode;
  orgName: string;
  userLabel: string;
  role: string;
  authMode: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const footer = (
    <div className="mt-auto border-t p-3">
      <div className="flex items-center gap-2 rounded-md px-2 py-2">
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">{userLabel.slice(0, 2)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{userLabel}</p>
          <p className="truncate text-xs text-muted-foreground capitalize">
            {role} · {orgName}
          </p>
        </div>
        {authMode !== "none" && (
          <button type="button" onClick={logout} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        )}
      </div>
      {authMode === "local" && <p className="px-2 pt-1 text-[11px] text-muted-foreground">Local auth mode (development)</p>}
      {authMode === "none" && <p className="px-2 pt-1 text-[11px] text-muted-foreground">Standalone mode: no sign-in, data stays on this computer</p>}
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r bg-card lg:flex">
        <Brand />
        <NavLinks />
        {footer}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col overflow-y-auto bg-card shadow-xl">
            <div className="flex items-center justify-between pr-3">
              <Brand />
              <button type="button" onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 hover:bg-muted" aria-label="Close menu">
                <X className="size-4" />
              </button>
            </div>
            <NavLinks onNavigate={() => setMobileOpen(false)} />
            {footer}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur lg:hidden">
          <button type="button" onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 hover:bg-muted" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold">{orgName}</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
