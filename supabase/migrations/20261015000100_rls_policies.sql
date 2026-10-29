-- Row Level Security: organization-level tenant isolation.
--
-- Roles inside an organization:
--   owner, admin  - manage settings, members, integrations metadata
--   member        - read and write business data (CRM, knowledge, runs)
--   viewer        - read only
--
-- Writes that must not be forged by a client (execution status/results,
-- integration status, audit logs, recommendations from the advisory agent)
-- are performed by the server with the service_role, which bypasses RLS.

create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org_id and m.user_id = auth.uid()
  )
$$;

create or replace function public.has_org_role(p_org_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  )
$$;

create or replace function public.can_write_org(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_role(p_org_id, array['owner', 'admin', 'member'])
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid, text[]) from public;
revoke all on function public.can_write_org(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.has_org_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.can_write_org(uuid) to authenticated, service_role;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.bootstrap_organization(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges. Explicit grants (instead of relying on platform defaults)
-- so the security model is fully described by the migrations.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Callback token hashes are server-only.
revoke select on public.agent_executions from authenticated;
grant select (
  id, organization_id, agent_slug, user_id, status, trigger, idempotency_key, retry_of,
  parent_execution_id, input_summary, input_ref, result, error_code, error_message,
  n8n_execution_id, ai_status, attempt, started_at, completed_at, duration_ms, created_at, updated_at
) on public.agent_executions to authenticated;

-- Secrets are server-only.
revoke all on public.integration_secrets from authenticated, anon;

-- Audit logs are append-only from the server.
revoke insert, update, delete on public.audit_logs from authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.agents enable row level security;
alter table public.agent_executions enable row level security;
alter table public.integrations enable row level security;
alter table public.integration_secrets enable row level security;
alter table public.contacts enable row level security;
alter table public.deals enable row level security;
alter table public.activities enable row level security;
alter table public.support_conversations enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.recommendations enable row level security;
alter table public.audit_logs enable row level security;

-- organizations
create policy organizations_select on public.organizations
  for select to authenticated using (public.is_org_member(id));
create policy organizations_update on public.organizations
  for update to authenticated
  using (public.has_org_role(id, array['owner', 'admin']))
  with check (public.has_org_role(id, array['owner', 'admin']));

-- profiles: own profile, plus read access to co-members (for owner names)
create policy profiles_select on public.profiles
  for select to authenticated using (
    id = auth.uid()
    or exists (
      select 1 from public.organization_members mine
      join public.organization_members theirs on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
  );
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (default_organization_id is null or public.is_org_member(default_organization_id))
  );

-- organization_members
create policy members_select on public.organization_members
  for select to authenticated using (public.is_org_member(organization_id));
create policy members_insert on public.organization_members
  for insert to authenticated with check (public.has_org_role(organization_id, array['owner', 'admin']));
create policy members_update on public.organization_members
  for update to authenticated
  using (public.has_org_role(organization_id, array['owner']))
  with check (public.has_org_role(organization_id, array['owner']));
create policy members_delete on public.organization_members
  for delete to authenticated using (
    public.has_org_role(organization_id, array['owner', 'admin']) and user_id <> auth.uid()
  );

-- agents
create policy agents_select on public.agents
  for select to authenticated using (public.is_org_member(organization_id));
create policy agents_update on public.agents
  for update to authenticated
  using (public.has_org_role(organization_id, array['owner', 'admin']))
  with check (public.has_org_role(organization_id, array['owner', 'admin']));

-- agent_executions: members read; writers create their own runs.
-- Status/result updates come from the server (service_role).
create policy executions_select on public.agent_executions
  for select to authenticated using (public.is_org_member(organization_id));
create policy executions_insert on public.agent_executions
  for insert to authenticated with check (
    public.can_write_org(organization_id) and user_id = auth.uid() and status = 'queued'
  );

-- integrations: metadata readable by members; changed only by the server
create policy integrations_select on public.integrations
  for select to authenticated using (public.is_org_member(organization_id));

-- integration_secrets: no policies (server only)

-- CRM tables
create policy contacts_select on public.contacts
  for select to authenticated using (public.is_org_member(organization_id));
create policy contacts_insert on public.contacts
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy contacts_update on public.contacts
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));
create policy contacts_delete on public.contacts
  for delete to authenticated using (public.can_write_org(organization_id));

create policy deals_select on public.deals
  for select to authenticated using (public.is_org_member(organization_id));
create policy deals_insert on public.deals
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy deals_update on public.deals
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));
create policy deals_delete on public.deals
  for delete to authenticated using (public.can_write_org(organization_id));

create policy activities_select on public.activities
  for select to authenticated using (public.is_org_member(organization_id));
create policy activities_insert on public.activities
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy activities_update on public.activities
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));
create policy activities_delete on public.activities
  for delete to authenticated using (public.can_write_org(organization_id));

-- support
create policy support_select on public.support_conversations
  for select to authenticated using (public.is_org_member(organization_id));
create policy support_insert on public.support_conversations
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy support_update on public.support_conversations
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

-- knowledge base
create policy knowledge_documents_select on public.knowledge_documents
  for select to authenticated using (public.is_org_member(organization_id));
create policy knowledge_documents_insert on public.knowledge_documents
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy knowledge_documents_update on public.knowledge_documents
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));
create policy knowledge_documents_delete on public.knowledge_documents
  for delete to authenticated using (public.can_write_org(organization_id));

create policy knowledge_chunks_select on public.knowledge_chunks
  for select to authenticated using (public.is_org_member(organization_id));
create policy knowledge_chunks_insert on public.knowledge_chunks
  for insert to authenticated with check (public.can_write_org(organization_id));
create policy knowledge_chunks_delete on public.knowledge_chunks
  for delete to authenticated using (public.can_write_org(organization_id));

-- recommendations: created by the server; members update status
create policy recommendations_select on public.recommendations
  for select to authenticated using (public.is_org_member(organization_id));
create policy recommendations_update on public.recommendations
  for update to authenticated
  using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

-- audit logs: owners and admins can read their organization's log
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.has_org_role(organization_id, array['owner', 'admin']));
