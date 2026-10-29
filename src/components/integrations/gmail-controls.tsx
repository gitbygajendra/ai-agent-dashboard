"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui";
import { toast } from "@/components/ui/client";
import { api } from "@/lib/utils";

export function GmailControls({ connected, canManage }: { connected: boolean; canManage: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  if (!canManage) return <p className="text-xs text-muted-foreground">Only owners and admins can change this connection.</p>;
  async function disconnect() {
    if (!confirm("Disconnect Gmail? Stored tokens are deleted. Pending drafts can no longer be sent.")) return;
    setLoading(true);
    try {
      await api("/api/integrations/gmail/disconnect", { method: "POST" });
      toast("Gmail disconnected", "success");
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="flex gap-2">
      {/* Full navigation: the server redirects to Google's consent screen. */}
      <a href="/api/integrations/gmail/connect" className={buttonVariants({ size: "sm", variant: connected ? "outline" : "default" })}>
        {connected ? "Reconnect" : "Connect Gmail"}
      </a>
      {connected && (
        <Button size="sm" variant="ghost" onClick={disconnect} loading={loading}>
          Disconnect
        </Button>
      )}
    </div>
  );
}
