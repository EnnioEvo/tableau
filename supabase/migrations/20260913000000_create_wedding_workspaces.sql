create table if not exists public.wedding_workspaces (
  id text primary key,
  workspace jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.wedding_workspaces enable row level security;

drop policy if exists "Public can read wedding workspace" on public.wedding_workspaces;
create policy "Public can read wedding workspace"
  on public.wedding_workspaces
  for select
  to anon, authenticated
  using (id = 'main');

drop policy if exists "Public can create wedding workspace" on public.wedding_workspaces;
create policy "Public can create wedding workspace"
  on public.wedding_workspaces
  for insert
  to anon, authenticated
  with check (id = 'main');

drop policy if exists "Public can update wedding workspace" on public.wedding_workspaces;
create policy "Public can update wedding workspace"
  on public.wedding_workspaces
  for update
  to anon, authenticated
  using (id = 'main')
  with check (id = 'main');

grant select, insert, update on public.wedding_workspaces to anon, authenticated;
