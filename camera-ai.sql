-- D-CHAL camera verification + AI scoring
-- Run once in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.verification_schedules (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null check (challenge_type in ('meal', 'workout')),
  label text not null,
  local_time time not null,
  timezone text not null default 'Asia/Seoul' check (timezone = 'Asia/Seoul'),
  days_of_week smallint[] not null default array[1,2,3,4,5,6,7]::smallint[],
  window_minutes integer not null default 10 check (window_minutes between 5 and 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, challenge_type, label)
);

create table if not exists public.verification_windows (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid references public.verification_schedules(id) on delete set null,
  schedule_date date,
  challenge_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_type text not null check (challenge_type in ('meal', 'workout')),
  scheduled_at timestamptz not null,
  expires_at timestamptz not null,
  random_code text not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'opened', 'submitted', 'missed', 'cancelled')),
  notified_at timestamptz,
  notification_attempts integer not null default 0,
  notification_error text,
  opened_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint verification_window_time_order check (expires_at > scheduled_at),
  constraint verification_window_random_code_length check (char_length(random_code) between 4 and 12)
);

alter table public.verification_windows
add column if not exists schedule_id uuid references public.verification_schedules(id) on delete set null;

alter table public.verification_windows
add column if not exists schedule_date date;

create unique index if not exists verification_windows_schedule_date_unique
on public.verification_windows (schedule_id, schedule_date)
where schedule_id is not null and schedule_date is not null;

create index if not exists verification_windows_due_idx
on public.verification_windows (status, scheduled_at, expires_at);

create index if not exists verification_windows_user_idx
on public.verification_windows (user_id, scheduled_at desc);

create table if not exists public.photo_submissions (
  id uuid primary key default gen_random_uuid(),
  verification_window_id uuid not null references public.verification_windows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  private_image_path text not null unique,
  captured_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  ai_valid boolean,
  ai_score integer check (ai_score between 0 and 100),
  ai_confidence numeric(4,3) check (ai_confidence between 0 and 1),
  ai_result_json jsonb,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'appealed')),
  appealed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (verification_window_id, user_id)
);

create index if not exists photo_submissions_user_idx
on public.photo_submissions (user_id, submitted_at desc);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
on public.push_subscriptions (user_id);

create table if not exists public.score_events (
  id uuid primary key default gen_random_uuid(),
  verification_window_id uuid references public.verification_windows(id) on delete cascade,
  challenge_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  points integer not null default 0,
  reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists score_events_missed_once_idx
on public.score_events (verification_window_id, user_id, event_type)
where verification_window_id is not null;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists verification_windows_touch_updated_at on public.verification_windows;
create trigger verification_windows_touch_updated_at
before update on public.verification_windows
for each row execute function public.touch_updated_at();

drop trigger if exists verification_schedules_touch_updated_at on public.verification_schedules;
create trigger verification_schedules_touch_updated_at
before update on public.verification_schedules
for each row execute function public.touch_updated_at();

drop trigger if exists photo_submissions_touch_updated_at on public.photo_submissions;
create trigger photo_submissions_touch_updated_at
before update on public.photo_submissions
for each row execute function public.touch_updated_at();

drop trigger if exists push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger push_subscriptions_touch_updated_at
before update on public.push_subscriptions
for each row execute function public.touch_updated_at();

alter table public.verification_schedules enable row level security;
alter table public.verification_windows enable row level security;
alter table public.photo_submissions enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.score_events enable row level security;

drop policy if exists "Users manage their verification schedules" on public.verification_schedules;
create policy "Users manage their verification schedules"
on public.verification_schedules
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users read their verification windows" on public.verification_windows;
create policy "Users read their verification windows"
on public.verification_windows
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users open their verification windows" on public.verification_windows;
create policy "Users open their verification windows"
on public.verification_windows
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users read their photo submissions" on public.photo_submissions;
create policy "Users read their photo submissions"
on public.photo_submissions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users create their own active submission" on public.photo_submissions;
create policy "Users create their own active submission"
on public.photo_submissions
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.verification_windows as window
    where window.id = verification_window_id
      and window.user_id = auth.uid()
      and window.status in ('scheduled', 'opened')
      and now() between window.scheduled_at and window.expires_at
  )
);

drop policy if exists "Users appeal their own submission" on public.photo_submissions;
create policy "Users appeal their own submission"
on public.photo_submissions
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users manage their push subscriptions" on public.push_subscriptions;
create policy "Users manage their push subscriptions"
on public.push_subscriptions
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users read their score events" on public.score_events;
create policy "Users read their score events"
on public.score_events
for select
to authenticated
using (auth.uid() = user_id);

revoke all on table public.verification_schedules from anon, authenticated;
grant select, insert, update, delete on table public.verification_schedules to authenticated;

revoke all on table public.verification_windows from anon, authenticated;
grant select on table public.verification_windows to authenticated;
grant update (status, opened_at) on table public.verification_windows to authenticated;

revoke all on table public.photo_submissions from anon, authenticated;
grant select, insert on table public.photo_submissions to authenticated;
grant update (review_status, appealed_at) on table public.photo_submissions to authenticated;

revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

revoke all on table public.score_events from anon, authenticated;
grant select on table public.score_events to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verification-photos',
  'verification-photos',
  false,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own verification photos" on storage.objects;
create policy "Users upload their own verification photos"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'verification-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users read their own verification photos" on storage.objects;
create policy "Users read their own verification photos"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'verification-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Users delete their own verification photos" on storage.objects;
create policy "Users delete their own verification photos"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'verification-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Called by pg_cron every minute. It creates a non-transferable point event only
-- when the user did not submit before the deadline. AI score never moves points.
create or replace function public.mark_expired_verification_windows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_count integer := 0;
begin
  with expired as (
    update public.verification_windows
    set status = 'missed',
        updated_at = now()
    where status in ('scheduled', 'opened')
      and expires_at < now()
    returning id, challenge_id, user_id
  ),
  inserted as (
    insert into public.score_events (
      verification_window_id,
      challenge_id,
      user_id,
      event_type,
      points,
      reason
    )
    select
      id,
      challenge_id,
      user_id,
      'verification_missed',
      -1000,
      '인증 시간 내 미제출'
    from expired
    on conflict do nothing
    returning 1
  )
  select count(*) into affected_count from inserted;

  return affected_count;
end;
$$;

revoke all on function public.mark_expired_verification_windows() from public;

-- Replaces the signed-in user's daily meal/workout times in one transaction.
create or replace function public.replace_my_verification_schedules(p_schedules jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  inserted_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if jsonb_typeof(p_schedules) <> 'array' or jsonb_array_length(p_schedules) > 8 then
    raise exception 'INVALID_SCHEDULES';
  end if;

  delete from public.verification_schedules
  where user_id = current_user_id
    and challenge_id is null;

  insert into public.verification_schedules (
    user_id,
    challenge_type,
    label,
    local_time,
    timezone,
    days_of_week,
    window_minutes
  )
  select
    current_user_id,
    item.challenge_type,
    left(item.label, 30),
    item.local_time::time,
    'Asia/Seoul',
    coalesce(item.days_of_week, array[1,2,3,4,5,6,7]::smallint[]),
    greatest(5, least(coalesce(item.window_minutes, 10), 60))
  from jsonb_to_recordset(p_schedules) as item(
    challenge_type text,
    label text,
    local_time text,
    timezone text,
    days_of_week smallint[],
    window_minutes integer
  )
  where item.challenge_type in ('meal', 'workout')
    and nullif(trim(item.label), '') is not null
    and item.local_time ~ '^[0-2][0-9]:[0-5][0-9]$';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.replace_my_verification_schedules(jsonb) from public;
grant execute on function public.replace_my_verification_schedules(jsonb) to authenticated;

-- Creates today's server-authoritative windows from the user's saved local time.
create or replace function public.materialize_due_verification_windows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  insert into public.verification_windows (
    schedule_id,
    schedule_date,
    challenge_id,
    user_id,
    challenge_type,
    scheduled_at,
    expires_at,
    random_code,
    status
  )
  select
    schedule.id,
    local_clock.local_now::date,
    schedule.challenge_id,
    schedule.user_id,
    schedule.challenge_type,
    (local_clock.local_now::date + schedule.local_time) at time zone schedule.timezone,
    ((local_clock.local_now::date + schedule.local_time) at time zone schedule.timezone)
      + make_interval(mins => schedule.window_minutes),
    'D' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4)),
    'scheduled'
  from public.verification_schedules as schedule
  cross join lateral (
    select timezone(schedule.timezone, now()) as local_now
  ) as local_clock
  where schedule.is_active
    and extract(isodow from local_clock.local_now)::smallint = any(schedule.days_of_week)
    and local_clock.local_now::time >= schedule.local_time
    and local_clock.local_now::time < schedule.local_time + interval '3 minutes'
  on conflict (schedule_id, schedule_date)
    where schedule_id is not null and schedule_date is not null
  do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.materialize_due_verification_windows() from public;

-- Atomically claims due windows so two scheduler calls cannot send the same
-- notification at the same time.
create or replace function public.claim_due_verification_windows(p_limit integer default 100)
returns table (
  id uuid,
  user_id uuid,
  challenge_type text,
  random_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select window.id
    from public.verification_windows as window
    where window.status = 'scheduled'
      and window.scheduled_at <= now()
      and window.expires_at > now()
      and window.notified_at is null
      and window.notification_attempts < 3
    order by window.scheduled_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.verification_windows as window
  set notified_at = now(),
      notification_attempts = window.notification_attempts + 1,
      notification_error = null,
      updated_at = now()
  from due
  where window.id = due.id
  returning
    window.id,
    window.user_id,
    window.challenge_type,
    window.random_code,
    window.expires_at;
end;
$$;

revoke all on function public.claim_due_verification_windows(integer) from public;

-- Seed one 10-minute test window for the currently signed-in SQL user is not
-- possible from the SQL editor. Replace USER_UUID before running this block
-- manually when you want to test the camera deep link.
--
-- insert into public.verification_windows (
--   user_id, challenge_type, scheduled_at, expires_at, random_code
-- ) values (
--   'USER_UUID', 'workout', now(), now() + interval '10 minutes', 'D7K2A'
-- );
