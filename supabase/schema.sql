create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  vod_url text not null,
  creator text,
  video_id text,
  status text not null default 'queued' check (status in ('queued','resolving','scanning','transcribing','ranking','completed','failed')),
  progress integer not null default 0 check (progress between 0 and 100),
  stage text not null default 'Na fila',
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists analysis_jobs_created_at_idx on public.analysis_jobs(created_at desc);
alter table public.analysis_jobs enable row level security;
-- O backend usa SUPABASE_SERVICE_ROLE_KEY; não exponha essa chave no navegador.
