-- Clip Finder V8 foundation
-- Run once in the Supabase SQL editor before enabling the V8 pipeline.

alter table public.analysis_jobs
  add column if not exists algo_version text default 'V7.0',
  add column if not exists lease_owner text,
  add column if not exists lease_until timestamptz,
  add column if not exists heartbeat_at timestamptz;

create index if not exists analysis_jobs_recovery_idx
  on public.analysis_jobs (status, updated_at);

create table if not exists public.vod_chunks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  chunk_index integer not null,
  start_seconds numeric not null,
  end_seconds numeric not null,
  status text not null default 'queued',
  transcript text,
  transcript_segments jsonb not null default '[]'::jsonb,
  signal_features jsonb not null default '{}'::jsonb,
  model text,
  prompt_hash text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, chunk_index)
);
create index if not exists vod_chunks_job_idx on public.vod_chunks(job_id, chunk_index);

create table if not exists public.clip_candidates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  start_seconds numeric not null,
  peak_seconds numeric,
  end_seconds numeric not null,
  arc_id text,
  discovery_sources jsonb not null default '[]'::jsonb,
  event_type text,
  participants jsonb not null default '[]'::jsonb,
  evidence text,
  summary text,
  clip_card jsonb not null default '{}'::jsonb,
  visual_evidence jsonb not null default '{}'::jsonb,
  rank integer,
  status text not null default 'discovered',
  algo_version text not null default 'V8',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clip_candidates_job_rank_idx on public.clip_candidates(job_id, rank);

create table if not exists public.clip_feedback (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.clip_candidates(id) on delete cascade,
  verdict text,
  reason_tags jsonb not null default '[]'::jsonb,
  edited_start_seconds numeric,
  edited_end_seconds numeric,
  posted boolean,
  platform text,
  post_url text,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vod_chunks enable row level security;
alter table public.clip_candidates enable row level security;
alter table public.clip_feedback enable row level security;

grant usage on schema public to service_role;
grant all privileges on table public.vod_chunks to service_role;
grant all privileges on table public.clip_candidates to service_role;
grant all privileges on table public.clip_feedback to service_role;
