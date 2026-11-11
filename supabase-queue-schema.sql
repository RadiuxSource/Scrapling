-- Run once in Supabase Dashboard -> SQL Editor.
-- The service-role key is used only by the server; never expose it to the browser.
-- Workspace rows use ids like ws_<opaque-workspace-key>. The legacy `main`
-- row is retained for the one-time owner migration.

create table if not exists public.vortex_queue_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- Remove legacy CHECK constraints that restrict the id column to the old
-- shared value ('main'). Workspace-scoped rows use ids like ws_<uuid>.
do $
declare
  constraint_row record;
  id_attnum smallint;
begin
  select attnum into id_attnum
  from pg_attribute
  where attrelid = 'public.vortex_queue_state'::regclass
    and attname = 'id'
    and not attisdropped;

  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.vortex_queue_state'::regclass
      and contype = 'c'
      and id_attnum = any(conkey)
  loop
    execute format('alter table public.vortex_queue_state drop constraint %I', constraint_row.conname);
  end loop;
end $;


alter table public.vortex_queue_state enable row level security;

-- No anon/authenticated policies are created. The server accesses this table
-- with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
revoke all on table public.vortex_queue_state from anon, authenticated;
grant all on table public.vortex_queue_state to service_role;
