-- Clip Finder V8.2 replay + funnel tracing
create table if not exists public.candidate_trace (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references public.analysis_jobs(id) on delete cascade,
 run_id text not null, candidate_key text not null, stage text not null,
 peak_seconds numeric, arc_id text, status text, rank integer, score numeric,
 payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists candidate_trace_job_run_idx on public.candidate_trace(job_id,run_id,stage);
grant all privileges on table public.candidate_trace to service_role;
alter table public.candidate_trace enable row level security;
