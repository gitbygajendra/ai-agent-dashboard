import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import type { AgentDefinition } from "@/lib/agents/registry";
import type { AgentRuntimeStatus } from "@/lib/agents/status";
import { Card, buttonVariants } from "./ui";
import { AgentIcon, ConnectionBadge, ExecutionStatusBadge, ImplementationBadge } from "./status";
import { timeAgo } from "@/lib/utils";

export function AgentCard({ agent, status }: { agent: AgentDefinition; status: AgentRuntimeStatus }) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start gap-3">
        <AgentIcon icon={agent.icon} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{agent.name}</h3>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <ConnectionBadge state={status.enabled ? status.connection : "not_connected"} />
        <ImplementationBadge level={agent.implementation} />
        {!status.enabled && <span className="text-xs text-muted-foreground">Turned off</span>}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Last run: {timeAgo(status.lastRunAt)}</span>
        {status.lastStatus && <ExecutionStatusBadge status={status.lastStatus} />}
      </div>
      <div className="mt-auto flex gap-2 pt-5">
        {agent.manualRun ? (
          <Link href={`/agents/${agent.slug}`} className={buttonVariants({ size: "sm" })}>
            <Play /> Run agent
          </Link>
        ) : (
          <Link href="/crm" className={buttonVariants({ size: "sm" })}>
            <Play /> Open CRM
          </Link>
        )}
        <Link href={`/agents/${agent.slug}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
          View details <ArrowRight />
        </Link>
      </div>
    </Card>
  );
}
