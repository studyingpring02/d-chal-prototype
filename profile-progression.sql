-- D-CHAL profile, character selection, and 10-win unlock progression
-- Run once in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.dchal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null default '나'
    check (char_length(btrim(nickname)) between 1 and 8),
  equipped_character_level integer not null default 0
    check (equipped_character_level between 0 and 5),
  total_wins integer not null default 0
    check (total_wins >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One trusted settlement result can change a user's win count only once.
create table if not exists public.dchal_battle_results (
  id uuid primary key default gen_random_uuid(),
  result_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  result text not null check (result in ('win', 'loss', 'draw')),
  created_at timestamptz not null default now(),
  unique (user_id, result_key)
);

create index if not exists dchal_battle_results_user_created_idx
on public.dchal_battle_results (user_id, created_at desc);

alter table public.dchal_profiles enable row level security;
alter table public.dchal_battle_results enable row level security;

revoke all on table public.dchal_profiles from public, anon, authenticated;
revoke all on table public.dchal_battle_results from public, anon, authenticated;

create or replace function public.dchal_profile_json(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'nickname', profile.nickname,
    'total_wins', profile.total_wins,
    'unlocked_character_level', least(5, profile.total_wins / 10),
    'equipped_character_level', least(
      profile.equipped_character_level,
      least(5, profile.total_wins / 10)
    ),
    'next_unlock_at', case
      when profile.total_wins >= 50 then null
      else (least(5, profile.total_wins / 10) + 1) * 10
    end
  )
  from public.dchal_profiles as profile
  where profile.user_id = p_user_id;
$$;

revoke all on function public.dchal_profile_json(uuid) from public, anon, authenticated;
grant execute on function public.dchal_profile_json(uuid) to service_role;

create or replace function public.get_my_dchal_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'authentication_required');
  end if;

  insert into public.dchal_profiles (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  return public.dchal_profile_json(v_user_id);
end;
$$;

revoke all on function public.get_my_dchal_profile() from public;
grant execute on function public.get_my_dchal_profile() to authenticated;

create or replace function public.save_my_dchal_profile(
  p_nickname text,
  p_equipped_character_level integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_total_wins integer;
  v_unlocked_level integer;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'authentication_required');
  end if;

  if char_length(v_nickname) not between 1 and 8
    or v_nickname ~ E'[\n\r\t]'
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_nickname');
  end if;

  insert into public.dchal_profiles (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select total_wins
  into v_total_wins
  from public.dchal_profiles
  where user_id = v_user_id
  for update;

  v_unlocked_level := least(5, v_total_wins / 10);
  if p_equipped_character_level is null
    or p_equipped_character_level < 0
    or p_equipped_character_level > v_unlocked_level
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'character_locked',
      'unlocked_character_level', v_unlocked_level
    );
  end if;

  update public.dchal_profiles
  set nickname = v_nickname,
      equipped_character_level = p_equipped_character_level,
      updated_at = now()
  where user_id = v_user_id;

  return public.dchal_profile_json(v_user_id);
end;
$$;

revoke all on function public.save_my_dchal_profile(text, integer) from public;
grant execute on function public.save_my_dchal_profile(text, integer) to authenticated;

-- Call this only from the trusted battle-settlement server with service_role.
-- Reusing the same result key cannot increment wins twice.
create or replace function public.record_dchal_battle_result(
  p_user_id uuid,
  p_result_key text,
  p_result text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result_id uuid;
  v_profile jsonb;
begin
  if p_user_id is null
    or char_length(btrim(coalesce(p_result_key, ''))) not between 1 and 120
    or p_result is null
    or p_result not in ('win', 'loss', 'draw')
  then
    raise exception 'INVALID_BATTLE_RESULT';
  end if;

  insert into public.dchal_profiles (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  insert into public.dchal_battle_results (result_key, user_id, result)
  values (btrim(p_result_key), p_user_id, p_result)
  on conflict (user_id, result_key) do nothing
  returning id into v_result_id;

  if v_result_id is not null and p_result = 'win' then
    update public.dchal_profiles
    set total_wins = total_wins + 1,
        updated_at = now()
    where user_id = p_user_id;
  end if;

  v_profile := public.dchal_profile_json(p_user_id);
  return v_profile || jsonb_build_object('duplicate', v_result_id is null);
end;
$$;

revoke all on function public.record_dchal_battle_result(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_dchal_battle_result(uuid, text, text) to service_role;

-- Real-user matching. Users are paired only when their goal is the same,
-- height differs by at most 2 cm, and weight differs by at most 3 kg.
create table if not exists public.dchal_matches (
  id uuid primary key default gen_random_uuid(),
  user_one_id uuid not null references auth.users(id) on delete cascade,
  user_two_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_one_id <> user_two_id)
);

create table if not exists public.dchal_match_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  height_cm integer not null check (height_cm between 120 and 220),
  weight_kg numeric(5,1) not null check (weight_kg between 30 and 300),
  goal_type text not null check (goal_type in ('gain', 'loss', 'maintain')),
  status text not null default 'waiting'
    check (status in ('waiting', 'matched', 'cancelled')),
  match_id uuid references public.dchal_matches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dchal_match_queue_candidate_idx
on public.dchal_match_queue (status, goal_type, updated_at desc);

create index if not exists dchal_matches_user_one_idx
on public.dchal_matches (user_one_id, status, created_at desc);

create index if not exists dchal_matches_user_two_idx
on public.dchal_matches (user_two_id, status, created_at desc);

alter table public.dchal_matches enable row level security;
alter table public.dchal_match_queue enable row level security;

revoke all on table public.dchal_matches from public, anon, authenticated;
revoke all on table public.dchal_match_queue from public, anon, authenticated;

create or replace function public.find_real_dchal_opponent(
  p_height_cm integer,
  p_weight_kg numeric,
  p_goal_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_opponent_user_id uuid;
  v_match_id uuid;
  v_opponent_nickname text;
  v_opponent_level integer;
  v_opponent_wins integer;
begin
  if v_user_id is null then
    return jsonb_build_object('matched', false, 'reason', 'authentication_required');
  end if;

  if p_height_cm is null
    or p_height_cm not between 120 and 220
    or p_weight_kg is null
    or p_weight_kg not between 30 and 300
    or p_goal_type is null
    or p_goal_type not in ('gain', 'loss', 'maintain')
  then
    return jsonb_build_object('matched', false, 'reason', 'invalid_preferences');
  end if;

  -- Serialize the short matching transaction so two simultaneous users cannot
  -- create duplicate matches with one another.
  perform pg_advisory_xact_lock(hashtext('dchal-real-user-matchmaking'));

  insert into public.dchal_profiles (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select
    case when match.user_one_id = v_user_id then match.user_two_id else match.user_one_id end,
    match.id
  into v_opponent_user_id, v_match_id
  from public.dchal_matches as match
  where match.status = 'active'
    and (match.user_one_id = v_user_id or match.user_two_id = v_user_id)
  order by match.created_at desc
  limit 1;

  if v_opponent_user_id is null then
    insert into public.dchal_match_queue (
      user_id, height_cm, weight_kg, goal_type, status, match_id, updated_at
    )
    values (
      v_user_id, p_height_cm, round(p_weight_kg, 1), p_goal_type, 'waiting', null, now()
    )
    on conflict (user_id) do update
    set height_cm = excluded.height_cm,
        weight_kg = excluded.weight_kg,
        goal_type = excluded.goal_type,
        status = 'waiting',
        match_id = null,
        updated_at = now();

    select queue.user_id
    into v_opponent_user_id
    from public.dchal_match_queue as queue
    where queue.user_id <> v_user_id
      and queue.status = 'waiting'
      and queue.updated_at >= now() - interval '15 minutes'
      and queue.goal_type = p_goal_type
      and abs(queue.height_cm - p_height_cm) <= 2
      and abs(queue.weight_kg - p_weight_kg) <= 3
    order by
      abs(queue.height_cm - p_height_cm),
      abs(queue.weight_kg - p_weight_kg),
      queue.updated_at
    limit 1
    for update;

    if v_opponent_user_id is null then
      return jsonb_build_object('matched', false, 'reason', 'no_compatible_user');
    end if;

    insert into public.dchal_profiles (user_id)
    values (v_opponent_user_id)
    on conflict (user_id) do nothing;

    insert into public.dchal_matches (user_one_id, user_two_id)
    values (v_user_id, v_opponent_user_id)
    returning id into v_match_id;

    update public.dchal_match_queue
    set status = 'matched', match_id = v_match_id, updated_at = now()
    where user_id in (v_user_id, v_opponent_user_id);
  end if;

  select
    profile.nickname,
    least(profile.equipped_character_level, least(5, profile.total_wins / 10)),
    profile.total_wins
  into v_opponent_nickname, v_opponent_level, v_opponent_wins
  from public.dchal_profiles as profile
  where profile.user_id = v_opponent_user_id;

  return jsonb_build_object(
    'matched', true,
    'match_id', v_match_id,
    'opponent', jsonb_build_object(
      'nickname', coalesce(v_opponent_nickname, '도전자'),
      'character_level', coalesce(v_opponent_level, 0),
      'total_wins', coalesce(v_opponent_wins, 0)
    )
  );
end;
$$;

revoke all on function public.find_real_dchal_opponent(integer, numeric, text) from public, anon;
grant execute on function public.find_real_dchal_opponent(integer, numeric, text) to authenticated;

create or replace function public.leave_real_dchal_match_queue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'authentication_required');
  end if;

  update public.dchal_match_queue
  set status = 'cancelled', match_id = null, updated_at = now()
  where user_id = v_user_id and status = 'waiting';

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.leave_real_dchal_match_queue() from public, anon;
grant execute on function public.leave_real_dchal_match_queue() to authenticated;

create or replace function public.get_dchal_ranking(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'nickname', ranked.nickname,
        'total_wins', ranked.total_wins,
        'character_level', ranked.character_level,
        'is_me', ranked.user_id = v_user_id
      )
      order by ranked.total_wins desc, ranked.updated_at, ranked.nickname
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      profile.user_id,
      profile.nickname,
      profile.total_wins,
      least(profile.equipped_character_level, least(5, profile.total_wins / 10)) as character_level,
      profile.updated_at
    from public.dchal_profiles as profile
    order by profile.total_wins desc, profile.updated_at, profile.nickname
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) as ranked;

  return v_result;
end;
$$;

revoke all on function public.get_dchal_ranking(integer) from public, anon;
grant execute on function public.get_dchal_ranking(integer) to authenticated;
