import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RunDetail } from "@/components/agents/run-detail";
import type { ExecutionDetail } from "@/components/agents/types";
import { AgentIcon } from "@/components/status";
import { canWrite, requirePageContext } from "@/lib/auth/context";
import { getExecution } from "@/lib/agents/executions";
import { AGENTS } from "@/lib/agents/registry";
import { AppError } from "@/lib/errors";

export const metadata = { title: "Run details" };

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const ctx = await requirePageContext();
  let execution;
  try {
    execution = await getExecution(ctx, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const agent = AGENTS[execution.agent_slug];
  return (
    <div className="space-y-6">
      <Link href="/runs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Workflow Runs
      </Link>
      <div className="flex items-center gap-3">
        <AgentIcon icon={agent.icon} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">Run {execution.id}</p>
        </div>
      </div>
      <RunDetail initial={execution as unknown as ExecutionDetail} canWrite={canWrite(ctx)} currency={ctx.currency} />
    </div>
  );
}
