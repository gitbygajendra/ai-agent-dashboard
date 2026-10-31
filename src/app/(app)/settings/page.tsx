import { CheckCircle2, Circle } from "lucide-react";
import { AgentSettingsForm, OrganizationForm } from "@/components/settings/settings-forms";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { isAdmin, requirePageContext } from "@/lib/auth/context";
import type { AgentSlug } from "@/lib/agents/registry";
import { getAgentStatuses } from "@/lib/agents/status";
import { withUser } from "@/lib/db";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requirePageContext();
  const admin = isAdmin(ctx);
  const [{ agents, integrations }, rows] = await Promise.all([
    getAgentStatuses(ctx),
    withUser(ctx.user.id, (tx) =>
      Promise.all([
        tx.query<{ slug: AgentSlug; enabled: boolean; config: { auto_send?: { enabled: boolean; categories: string[] } } }>(
          "select slug, enabled, config from public.agents where organization_id = $1",
          [ctx.orgId],
        ),
        tx.query<{ user_id: string; role: string; email: string | null; full_name: string | null; created_at: string }>(
          `select m.user_id, m.role, p.email, p.full_name, m.created_at from public.organization_members m
             left join public.profiles p on p.id = m.user_id where m.organization_id = $1 order by m.created_at`,
          [ctx.orgId],
        ),
        admin
          ? tx.query<{ action: string; created_at: string; entity_type: string | null; actor: string | null }>(
              `select a.action, a.created_at, a.entity_type, coalesce(p.full_name, p.email) as actor
                 from public.audit_logs a left join public.profiles p on p.id = a.actor_id
                where a.organization_id = $1 order by a.created_at desc limit 15`,
              [ctx.orgId],
            )
          : Promise.resolve([]),
      ]),
    ),
  ]);
  const [agentRows, members, auditRows] = rows;
  const autoSend = agentRows.find((a) => a.slug === "email-automation-agent")?.config?.auto_send ?? { enabled: false, categories: [] };
  const state = (p: string) => integrations.find((i) => i.provider === p)?.state;
  const e = env();

  const checklist = e.ENGINE === "builtin" && e.AUTH_MODE === "none" ? [
    { done: true, label: "Standalone mode: embedded database in .data/db, built-in agent engine, no sign-in", note: "Nothing else to install. Set DATABASE_URL / N8N_BASE_URL in .env.local to switch to Postgres and n8n." },
    { done: state("llm") === "connected", label: "AI key in .env.local (GROQ_API_KEY or ANTHROPIC_API_KEY), verified by a successful AI step", note: "Optional: without it agents return computed results." },
    { done: state("gmail") === "connected", label: "Gmail connected (Google OAuth client + ENCRYPTION_KEY, optional)" },
  ] : [
    { done: e.AUTH_MODE === "supabase", label: "Supabase project created, migrations applied, Supabase Auth configured", note: e.AUTH_MODE === "local" ? "Running with local development auth." : undefined },
    { done: Boolean(e.SUPABASE_SERVICE_ROLE_KEY), label: "Private storage bucket available (Supabase Storage)", note: !e.SUPABASE_SERVICE_ROLE_KEY ? "Files are stored on the local disk." : undefined },
    { done: state("n8n") === "connected", label: "n8n reachable with N8N_BASE_URL and N8N_WEBHOOK_SECRET" },
    { done: agents.every((a) => a.connection !== "not_connected"), label: "Master workflow (n8n/agent-dashboard-master.json) imported into n8n and published" },
    { done: state("llm") === "connected", label: "AI key available to n8n (verified by a successful AI step)" },
    { done: state("gmail") === "connected", label: "Gmail connected (Google OAuth client + ENCRYPTION_KEY)" },
    { done: state("lead_provider") === "connected", label: "Lead data provider (optional)" },
    { done: state("order_system") === "connected", label: "Order system for support lookups (optional)" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={`Signed in as ${ctx.user.email ?? "you"} · role ${ctx.role}`} />
      <OrganizationForm name={ctx.orgName} currency={ctx.currency} canEdit={admin} />
      <AgentSettingsForm agents={agentRows.map((a) => ({ slug: a.slug, enabled: a.enabled }))} autoSend={autoSend} canEdit={admin} />

      <Card id="setup">
        <CardHeader>
          <CardTitle>Setup checklist</CardTitle>
          <CardDescription>What this workspace still needs. Full instructions are in README.md and n8n/README.md.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {checklist.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-sm">
                {c.done ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : <Circle className="mt-0.5 size-4 text-muted-foreground/60" />}
                <span>
                  {c.label}
                  {c.note && <span className="block text-xs text-muted-foreground">{c.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Everyone with access to this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Role</TH>
                  <TH>Joined</TH>
                </TR>
              </THead>
              <TBody>
                {members.map((m) => (
                  <TR key={m.user_id}>
                    <TD>
                      <p className="font-medium">{m.full_name ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{m.email}</p>
                    </TD>
                    <TD>
                      <Badge tone={m.role === "owner" ? "primary" : "neutral"} className="capitalize">
                        {m.role}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground">{formatDate(m.created_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        {admin && (
          <Card>
            <CardHeader>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>Recent security-sensitive and business-critical actions.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-2">
              {auditRows.length === 0 ? (
                <p className="px-5 pb-4 text-sm text-muted-foreground">No entries yet.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Action</TH>
                      <TH>By</TH>
                      <TH>When</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {auditRows.map((a, i) => (
                      <TR key={i}>
                        <TD className="font-mono text-xs">{a.action}</TD>
                        <TD className="text-muted-foreground">{a.actor ?? "System"}</TD>
                        <TD className="whitespace-nowrap text-muted-foreground">{new Date(a.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
