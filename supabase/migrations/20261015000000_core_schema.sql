-- Core schema for the AI Agent Dashboard.
-- Every business table carries organization_id; RLS policies (next migration)
-- restrict rows to members of that organization.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations, profiles, memberships
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  default_organization_id uuid references public.organizations (id) on delete set null,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

-- ---------------------------------------------------------------------------
-- Agents and executions
-- ---------------------------------------------------------------------------

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  slug text not null check (slug in (
    'data-analytics-agent', 'email-automation-agent', 'finance-audit-agent',
    'crm-automation-agent', 'data-advisory-agent', 'customer-support-agent',
    'lead-generation-agent'
  )),
  enabled boolean not null default true,
  -- Non-secret settings only (thresholds, toggles). Secrets live in n8n
  -- credentials or integration_secrets.
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table public.agent_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_slug text not null,
  user_id uuid references auth.users (id) on delete set null,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'timed_out', 'cancelled'
  )),
  trigger text not null default 'manual' check (trigger in ('manual', 'retry', 'crm_event', 'approval', 'system')),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 128),
  retry_of uuid references public.agent_executions (id) on delete set null,
  parent_execution_id uuid references public.agent_executions (id) on delete set null,
  -- Metadata about the input (file name, row count, question). Never raw secrets.
  input_summary jsonb not null default '{}'::jsonb,
  -- Pointer to stored input (e.g. private storage path) so retries can re-run.
  input_ref jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  n8n_execution_id text,
  -- Whether the AI step ran: used | skipped | unavailable (credential missing, refusal, error)
  ai_status text check (ai_status is null or ai_status in ('used', 'skipped', 'unavailable')),
  -- SHA-256 of the single-use callback token handed to n8n. Not client readable.
  callback_token_hash text,
  attempt integer not null default 1 check (attempt >= 1),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index agent_executions_idempotency_idx
  on public.agent_executions (organization_id, idempotency_key)
  where idempotency_key is not null;
create index agent_executions_org_created_idx on public.agent_executions (organization_id, created_at desc);
create index agent_executions_org_agent_idx on public.agent_executions (organization_id, agent_slug, created_at desc);
create index agent_executions_org_status_idx on public.agent_executions (organization_id, status);
create index agent_executions_user_created_idx on public.agent_executions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Integrations (connection metadata only; secrets are in integration_secrets)
-- ---------------------------------------------------------------------------

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null check (provider in ('n8n', 'llm', 'gmail', 'lead_provider', 'order_system')),
  status text not null default 'not_connected' check (status in ('connected', 'not_connected', 'needs_attention')),
  account_label text,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

-- Encrypted (AES-256-GCM, app-level key) OAuth tokens and API keys.
-- RLS is enabled with no policies, and privileges are revoked from client
-- roles, so only the server (service_role) can read it.
create table public.integration_secrets (
  integration_id uuid primary key references public.integrations (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  email text check (email is null or (char_length(email) <= 320 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone text check (phone is null or char_length(phone) <= 40),
  company text check (company is null or char_length(company) <= 200),
  source text check (source is null or char_length(source) <= 80),
  status text not null default 'lead' check (status in ('lead', 'qualified', 'customer', 'unqualified', 'churned')),
  owner_id uuid references auth.users (id) on delete set null,
  tags text[] not null default '{}',
  lead_score integer check (lead_score is null or lead_score between 0 and 100),
  consent_status text not null default 'unknown' check (consent_status in ('unknown', 'opted_in', 'opted_out')),
  industry text,
  location text,
  company_size text,
  is_demo boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index contacts_org_email_idx on public.contacts (organization_id, lower(email)) where email is not null;
create index contacts_org_status_idx on public.contacts (organization_id, status);
create index contacts_org_created_idx on public.contacts (organization_id, created_at desc);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid,
  title text not null check (char_length(title) between 1 and 200),
  value numeric(14, 2) not null default 0 check (value >= 0),
  currency char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  stage text not null default 'new' check (stage in ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  expected_close_date date,
  owner_id uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  is_demo boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  -- Composite FK keeps a deal and its contact inside the same organization.
  foreign key (contact_id, organization_id) references public.contacts (id, organization_id) on delete cascade
);
-- Deleting a contact keeps its deals (detached) instead of cascading.
create or replace function public.detach_contact_deals() returns trigger
language plpgsql
as $$
begin
  update public.deals set contact_id = null where contact_id = old.id;
  return old;
end;
$$;
create trigger contacts_detach_deals before delete on public.contacts
  for each row execute function public.detach_contact_deals();

create index deals_org_stage_idx on public.deals (organization_id, stage);
create index deals_contact_idx on public.deals (contact_id);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid,
  deal_id uuid,
  type text not null check (type in ('note', 'task', 'call', 'email', 'meeting', 'reminder', 'system')),
  subject text not null check (char_length(subject) between 1 and 300),
  body text check (body is null or char_length(body) <= 10000),
  due_at timestamptz,
  completed_at timestamptz,
  execution_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (contact_id, organization_id) references public.contacts (id, organization_id) on delete cascade,
  foreign key (deal_id, organization_id) references public.deals (id, organization_id) on delete cascade
);
create index activities_contact_idx on public.activities (contact_id, created_at desc);
create index activities_deal_idx on public.activities (deal_id, created_at desc);
create index activities_org_due_idx on public.activities (organization_id, due_at) where completed_at is null;

-- ---------------------------------------------------------------------------
-- Customer support and knowledge base
-- ---------------------------------------------------------------------------

create table public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_name text check (customer_name is null or char_length(customer_name) <= 200),
  customer_email text check (customer_email is null or char_length(customer_email) <= 320),
  channel text not null default 'dashboard' check (channel in ('dashboard', 'widget')),
  status text not null default 'open' check (status in ('open', 'resolved', 'escalated', 'closed')),
  topic text,
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'high', 'urgent')),
  messages jsonb not null default '[]'::jsonb,
  ticket_ref text,
  escalated_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_conversations_org_status_idx on public.support_conversations (organization_id, status, updated_at desc);

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  source_type text not null default 'upload' check (source_type in ('upload', 'text')),
  storage_path text,
  mime_type text,
  size_bytes integer check (size_bytes is null or size_bytes >= 0),
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  chunk_count integer not null default 0,
  approved boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

-- Retrieval chunks with a full-text index. A vector column can be added later
-- (pgvector) without changing the API that reads from this table.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null,
  content text not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  foreign key (document_id, organization_id) references public.knowledge_documents (id, organization_id) on delete cascade,
  unique (document_id, chunk_index)
);
create index knowledge_chunks_tsv_idx on public.knowledge_chunks using gin (tsv);
create index knowledge_chunks_org_idx on public.knowledge_chunks (organization_id);

-- ---------------------------------------------------------------------------
-- Advisory recommendations
-- ---------------------------------------------------------------------------

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  execution_id uuid references public.agent_executions (id) on delete set null,
  key text,
  title text not null check (char_length(title) between 1 and 300),
  rationale text,
  actions jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  confidence text check (confidence in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'completed', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recommendations_org_status_idx on public.recommendations (organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Audit log (append-only from the server)
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations', 'profiles', 'agents', 'agent_executions', 'integrations',
    'contacts', 'deals', 'activities', 'support_conversations',
    'knowledge_documents', 'recommendations'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- New-user bootstrap: profile + personal workspace + default agent/integration rows
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_organization(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.agents (organization_id, slug)
  select p_org_id, s
  from unnest(array[
    'data-analytics-agent', 'email-automation-agent', 'finance-audit-agent',
    'crm-automation-agent', 'data-advisory-agent', 'customer-support-agent',
    'lead-generation-agent'
  ]) as s
  on conflict (organization_id, slug) do nothing;

  insert into public.integrations (organization_id, provider)
  select p_org_id, p
  from unnest(array['n8n', 'llm', 'gmail', 'lead_provider', 'order_system']) as p
  on conflict (organization_id, provider) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_org_name text;
begin
  v_org_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'organization_name'), ''),
    split_part(coalesce(new.email, 'My'), '@', 1) || '''s workspace'
  );

  insert into public.organizations (name)
  values (left(v_org_name, 120))
  returning id into v_org_id;

  insert into public.profiles (id, email, full_name, default_organization_id)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), v_org_id);

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org_id, new.id, 'owner');

  perform public.bootstrap_organization(v_org_id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
