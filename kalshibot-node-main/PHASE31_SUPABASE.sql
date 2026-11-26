-- Separate research-only table. No live trades or account data.
create table if not exists public.kalshibot_paper_observations (
 ticker text primary key,
 payload jsonb not null,
 updated_at timestamptz not null default now()
);
alter table public.kalshibot_paper_observations enable row level security;
revoke all on public.kalshibot_paper_observations from anon, authenticated;
create index if not exists kalshibot_paper_observations_updated_idx
 on public.kalshibot_paper_observations(updated_at desc);
