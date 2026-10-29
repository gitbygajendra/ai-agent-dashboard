-- Private storage bucket for uploaded datasets, finance files and knowledge
-- documents. Files are read and written only by the server (service_role),
-- under paths prefixed with the organization id; there are no client policies,
-- so the bucket is not reachable with the anon or user keys.
--
-- Skipped automatically on plain PostgreSQL (local development), where the
-- app stores files on disk instead.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'agent-files',
      'agent-files',
      false,
      10485760,
      array[
        'text/csv',
        'text/plain',
        'text/markdown',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream'
      ]
    )
    on conflict (id) do update set public = false;
  end if;
end
$$;
