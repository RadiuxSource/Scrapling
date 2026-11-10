-- Run once in Supabase Dashboard -> SQL Editor.
-- The service-role key is used only by the server; never expose it to the browser.

create table if not exists public.vortex_queue_state (
  id text primary key check (id = 'main'),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.vortex_queue_state enable row level security;

-- No anon/authenticated policies are created. The server accesses this table
-- with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
revoke all on table public.vortex_queue_state from anon, authenticated;
grant all on table public.vortex_queue_state to service_role;
