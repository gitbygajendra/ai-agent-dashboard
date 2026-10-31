import { AgentCard } from "@/components/agent-card";
import { PageHeader } from "@/components/ui";
import { requirePageContext } from "@/lib/auth/context";
import { AGENT_SLUGS, AGENTS } from "@/lib/agents/registry";
import { getAgentStatuses } from "@/lib/agents/status";

export const metadata = { title: "AI Agents" };

export default async function AgentsPage() {
  const ctx = await requirePageContext();
  const { agents } = await getAgentStatuses(ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI Agents" description="Each agent runs as a step-by-step pipeline. Open one to run it, see its steps, results and history." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AGENT_SLUGS.map((slug) => (
          <AgentCard key={slug} agent={AGENTS[slug]} status={agents.find((a) => a.slug === slug)!} />
        ))}
      </div>
    </div>
  );
}
