import { BarChart3, Calculator, Lightbulb, Mail, MessagesSquare, Target, Users } from "lucide-react";
import type { AgentDefinition, ImplementationLevel } from "@/lib/agents/registry";
import { Badge } from "./ui";
import { cn } from "@/lib/utils";

const ICONS = { BarChart3, Mail, Calculator, Users, Lightbulb, MessagesSquare, Target };

export function AgentIcon({ icon, className }: { icon: AgentDefinition["icon"]; className?: string }) {
  const Icon = ICONS[icon];
  return (
    <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary", className)}>
      <Icon className="size-4.5" aria-hidden />
    </span>
  );
}

const EXECUTION: Record<string, { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "primary" },
  awaiting_approval: { label: "Needs approval", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  timed_out: { label: "Timed out", tone: "danger" },
  cancelled: { label: "Dismissed", tone: "neutral" },
};

export function ExecutionStatusBadge({ status }: { status: string }) {
  const s = EXECUTION[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Badge tone={s.tone}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />}
      {s.label}
    </Badge>
  );
}

const CONNECTION: Record<string, { label: string; tone: "success" | "neutral" | "warning" }> = {
  connected: { label: "Connected", tone: "success" },
  not_connected: { label: "Not connected", tone: "neutral" },
  needs_attention: { label: "Needs attention", tone: "warning" },
};

export function ConnectionBadge({ state }: { state: string }) {
  const s = CONNECTION[state] ?? CONNECTION.not_connected;
  return (
    <Badge tone={s.tone}>
      <span className={cn("size-1.5 rounded-full", s.tone === "success" ? "bg-success" : s.tone === "warning" ? "bg-warning" : "bg-muted-foreground/50")} aria-hidden />
      {s.label}
    </Badge>
  );
}

const LEVEL: Record<ImplementationLevel, { label: string; tone: "success" | "warning" | "neutral" }> = {
  implemented: { label: "Fully implemented", tone: "success" },
  partial: { label: "Partially implemented", tone: "warning" },
  awaiting_integration: { label: "Awaiting integration", tone: "neutral" },
};

export function ImplementationBadge({ level }: { level: ImplementationLevel }) {
  const s = LEVEL[level];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function AiBadge({ status }: { status: string | null | undefined }) {
  if (status === "used") return <Badge tone="primary">AI summary</Badge>;
  if (status === "unavailable") return <Badge tone="warning">AI unavailable · computed results</Badge>;
  if (status === "skipped") return <Badge tone="neutral">Computed only</Badge>;
  return null;
}

export function DemoBadge() {
  return <Badge tone="warning">Demo</Badge>;
}
