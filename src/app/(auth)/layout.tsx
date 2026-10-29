import { Bot } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </span>
          <span className="font-semibold">Agent Workspace</span>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">{children}</div>
        <p className="text-center text-xs text-muted-foreground">Seven AI agents, one workspace. Automation runs on your n8n instance.</p>
      </div>
    </main>
  );
}
