-- D-CHAL weekly health-meal challenge membership and AI score history.
-- Run after supabase/camera-ai.sql because scores reference photo_submissions.

create table if not exists public.meal_challenge_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.meal_challenge_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  submission_id uuid not null unique references public.photo_submissions(id) on delete cascade,
  meal_mode text not null check (meal_mode in ('regular', 'dining')),
  health_score integer not null check (health_score between 0 and 100),
  character_tier text not null check (character_tier in ('alert', 'caution', 'good')),
  menu_name text,
  scored_at timestamptz not null default now()
);

create index if not exists meal_challenge_scores_user_week_idx
on public.meal_challenge_scores (user_id, scored_at desc);

alter table public.meal_challenge_memberships enable row level security;
alter table public.meal_challenge_scores enable row level security;

drop policy if exists "Users read their meal challenge membership" on public.meal_challenge_memberships;
create policy "Users read their meal challenge membership"
on public.meal_challenge_memberships
for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users create their meal challenge membership" on public.meal_challenge_memberships;
create policy "Users create their meal challenge membership"
on public.meal_challenge_memberships
for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users update their meal challenge membership" on public.meal_challenge_memberships;
create policy "Users update their meal challenge membership"
on public.meal_challenge_memberships
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users read their meal challenge scores" on public.meal_challenge_scores;
create policy "Users read their meal challenge scores"
on public.meal_challenge_scores
for select to authenticated
using (auth.uid() = user_id);

revoke all on table public.meal_challenge_memberships from anon, authenticated;
grant select, insert, update on table public.meal_challenge_memberships to authenticated;

revoke all on table public.meal_challenge_scores from anon, authenticated;
grant select on table public.meal_challenge_scores to authenticated;

-- Creates a short server-authoritative meal window when the user starts a meal
-- verification from the challenge screen. Existing active windows are reused.
create or replace function public.open_my_meal_verification_window()
returns public.verification_windows
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  active_window public.verification_windows;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select window.*
  into active_window
  from public.verification_windows as window
  where window.user_id = current_user_id
    and window.challenge_type = 'meal'
    and window.status in ('scheduled', 'opened')
    and now() between window.scheduled_at and window.expires_at
  order by window.scheduled_at desc
  limit 1;

  if found then
    update public.verification_windows
    set status = 'opened',
        opened_at = coalesce(opened_at, now()),
        updated_at = now()
    where id = active_window.id
    returning * into active_window;
    return active_window;
  end if;

  insert into public.verification_windows (
    user_id,
    challenge_type,
    scheduled_at,
    expires_at,
    random_code,
    status,
    opened_at
  ) values (
    current_user_id,
    'meal',
    now() - interval '30 seconds',
    now() + interval '15 minutes',
    'M' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
    'opened',
    now()
  )
  returning * into active_window;

  return active_window;
end;
$$;

revoke all on function public.open_my_meal_verification_window() from public;
grant execute on function public.open_my_meal_verification_window() to authenticated;
