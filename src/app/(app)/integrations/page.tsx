import Link from "next/link";
import { Bot, BrainCircuit, Mail, Package, Search, Workflow } from "lucide-react";
import { GmailControls } from "@/components/integrations/gmail-controls";
import { ConnectionBadge } from "@/components/status";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { isAdmin, requirePageContext } from "@/lib/auth/context";
import { AGENTS, INTEGRATIONS, type IntegrationProvider } from "@/lib/agents/registry";
import { getIntegrationStatuses } from "@/lib/integrations/status";
import { timeAgo } from "@/lib/utils";

export const metadata = { title: "Integrations" };

const ICONS: Record<IntegrationProvider, React.ComponentType<{ className?: string }>> = {
  n8n: Workflow,
  llm: BrainCircuit,
  gmail: Mail,
  lead_provider: Search,
  order_system: Package,
};

const GMAIL_MESSAGES: Record<string, { tone: "success" | "danger" | "warning"; text: string }> = {
  connected: { tone: "success", text: "Gmail connected." },
  denied: { tone: "warning", text: "Google access was not granted." },
  invalid_state: { tone: "danger", text: "The Google sign-in link expired or didn't match this session. Try again." },
  missing_code: { tone: "danger", text: "Google didn't return an authorization code. Try again." },
  error: { tone: "danger", text: "Connecting Gmail failed. Check the server logs and your Google OAuth settings." },
};

export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const { integrations, workflows } = await getIntegrationStatuses(ctx);
  const gmailMsg = typeof sp.gmail === "string" ? GMAIL_MESSAGES[sp.gmail] : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connections the agents use. Secrets stay on the server or in n8n; this page shows status only."
      />
      {gmailMsg && <Alert tone={gmailMsg.tone}>{gmailMsg.text}</Alert>}

      <div className="grid gap-4 md:grid-cols-2">
        {integrations.map((i) => {
          const Icon = ICONS[i.provider];
          const meta = INTEGRATIONS[i.provider];
          return (
            <Card key={i.provider} className="flex flex-col">
              <CardHeader className="flex-row items-start gap-3 space-y-0">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="size-4.5 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{meta.name}</CardTitle>
                    <ConnectionBadge state={i.state} />
                  </div>
                  <CardDescription>{meta.description}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="mt-auto space-y-3 text-sm">
                <p>{i.detail}</p>
                {i.account && (
                  <p className="text-muted-foreground">
                    Account: <span className="font-mono text-xs text-foreground">{i.account}</span>
                  </p>
                )}
                {i.lastCheckedAt && <p className="text-xs text-muted-foreground">Last checked {timeAgo(i.lastCheckedAt)}</p>}
                {i.state !== "connected" && <p className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">How to connect: {meta.setup}</p>}
                {i.provider === "gmail" && i.canConnect && <GmailControls connected={i.state !== "not_connected"} canManage={isAdmin(ctx)} />}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" /> Agents in the n8n master workflow
          </CardTitle>
          <CardDescription>
            All seven agents run through one workflow: import <code className="text-xs">n8n/agent-dashboard-master.json</code> into n8n and publish it. See the{" "}
            <Link className="text-primary hover:underline" href="/settings#setup">
              setup checklist
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          <Table>
            <THead>
              <TR>
                <TH>Agent</TH>
                <TH>Routed as</TH>
                <TH>Webhook</TH>
                <TH>Last setup error</TH>
              </TR>
            </THead>
            <TBody>
              {workflows.map((w) => (
                <TR key={w.slug}>
                  <TD className="whitespace-nowrap font-medium">{AGENTS[w.slug].name}</TD>
                  <TD className="font-mono text-xs">agent: {w.slug}</TD>
                  <TD>
                    <ConnectionBadge state={!w.configured ? "not_connected" : w.lastErrorCode ? "needs_attention" : "connected"} />
                  </TD>
                  <TD className="max-w-[360px] text-xs text-muted-foreground">{w.lastError ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
