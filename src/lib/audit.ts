import "server-only";
import { withService, type Tx } from "./db";
import { logger } from "./logger";

export type AuditEntry = {
  orgId: string | null;
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
};

const INSERT = `insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, metadata)
                values ($1, $2, $3, $4, $5, $6)`;

function params(e: AuditEntry) {
  return [e.orgId, e.actorId, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.metadata ?? {})];
}

/** Record a security-sensitive or business-critical action. Never throws. */
export async function audit(entry: AuditEntry, tx?: Tx): Promise<void> {
  try {
    if (tx) await tx.query(INSERT, params(entry));
    else await withService((s) => s.query(INSERT, params(entry)));
  } catch (err) {
    logger.error("audit_write_failed", { action: entry.action, error: (err as Error).message });
  }
}
