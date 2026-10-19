create table if not exists public.chemistry_study_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.chemistry_study_progress enable row level security;

drop policy if exists "Users can read their chemistry progress" on public.chemistry_study_progress;
create policy "Users can read their chemistry progress"
on public.chemistry_study_progress
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their chemistry progress" on public.chemistry_study_progress;
create policy "Users can insert their chemistry progress"
on public.chemistry_study_progress
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their chemistry progress" on public.chemistry_study_progress;
create policy "Users can update their chemistry progress"
on public.chemistry_study_progress
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
