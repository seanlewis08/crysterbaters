-- League For Kids That Read Good — database for logins and polls.
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: every statement is "if not exists" or "create or replace".
--
-- How membership works: anyone can request a sign-in link, but they can't
-- see or do anything until they claim one of the ten teams with the league
-- code. Each team can be claimed once. The commissioner can release a claim
-- and change the code from the site.

create extension if not exists pgcrypto;
drop trigger if exists only_members_may_join on auth.users;  -- from an earlier draft

-- ----------------------------------------------------------------------
-- 1. League settings: the invite code and who the commissioner is.
-- ----------------------------------------------------------------------
create table if not exists public.league_settings (
  id                 int primary key check (id = 1),
  invite_code        text not null,
  commissioner_email text not null
);
insert into public.league_settings (id, invite_code, commissioner_email)
  values (1, 'KIDS26', 'seanlewis08@gmail.com')
on conflict (id) do nothing;   -- keeps whatever code Sean has set since

-- ----------------------------------------------------------------------
-- 2. Profiles: one signed-in user ↔ one team.
-- ----------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  team_id    text not null unique check (team_id in
               ('knuepp','claxton','rollins','george','rucker','ant','ysga','freaky','giannis','jalenba')),
  created_at timestamptz not null default now()
);

-- Helpers. security definer so policies can call them without recursion.
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.user_id = auth.uid());
$$;

create or replace function public.is_commissioner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.league_settings s on lower(s.commissioner_email) = lower(p.email)
    where p.user_id = auth.uid() and s.id = 1
  );
$$;

-- Which teams are already taken (no emails exposed). Readable before you
-- are a member so the claim screen can grey them out.
create or replace view public.claimed_teams
with (security_invoker = false) as
  select team_id from public.profiles;

create or replace function public.claim_team(p_team_id text, p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select invite_code into v_code from public.league_settings where id = 1;
  if v_code is null or upper(trim(p_code)) <> upper(trim(v_code)) then
    raise exception 'That league code isn''t right.';
  end if;
  if exists (select 1 from public.profiles where user_id = auth.uid()) then
    raise exception 'You already have a team.';
  end if;
  if exists (select 1 from public.profiles where team_id = p_team_id) then
    raise exception 'That team has already been claimed. Ask Sean if it''s yours.';
  end if;
  insert into public.profiles (user_id, email, team_id)
    values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), p_team_id);
end $$;

create or replace function public.release_team(p_team_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commissioner() then raise exception 'Commissioner only.'; end if;
  delete from public.profiles where team_id = p_team_id;
end $$;

create or replace function public.set_invite_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commissioner() then raise exception 'Commissioner only.'; end if;
  if length(trim(p_code)) < 4 then raise exception 'Make the code at least four characters.'; end if;
  update public.league_settings set invite_code = trim(p_code) where id = 1;
end $$;

-- ----------------------------------------------------------------------
-- 3. Polls
-- ----------------------------------------------------------------------
create table if not exists public.polls (
  id               uuid primary key default gen_random_uuid(),
  question         text not null check (length(question) between 1 and 300),
  options          text[] not null check (array_length(options, 1) between 2 and 12),
  -- named: everyone sees who voted for what
  -- anon: only totals, ever
  -- anon_until_close: totals while open, names once the poll closes
  visibility       text not null default 'named' check (visibility in ('named', 'anon', 'anon_until_close')),
  closes_at        timestamptz,
  closed           boolean not null default false,
  created_by       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now()
);

create table if not exists public.votes (
  poll_id      uuid not null references public.polls (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  voter_email  text not null default coalesce(auth.jwt() ->> 'email', ''),
  option_index int not null check (option_index >= 0),
  created_at   timestamptz not null default now(),
  primary key (poll_id, user_id)
);

create or replace function public.poll_is_open(p public.polls)
returns boolean language sql stable as $$
  select not p.closed and (p.closes_at is null or p.closes_at > now());
$$;

-- Vote totals without voter identity. Bypasses row security on votes on
-- purpose: it only ever exposes counts.
create or replace view public.poll_tallies
with (security_invoker = false) as
  select poll_id, option_index, count(*)::int as n
  from public.votes
  group by poll_id, option_index;

-- ----------------------------------------------------------------------
-- 4. Row-level security
-- ----------------------------------------------------------------------
alter table public.league_settings enable row level security;
alter table public.profiles        enable row level security;
alter table public.polls           enable row level security;
alter table public.votes           enable row level security;

drop policy if exists settings_read on public.league_settings;
create policy settings_read on public.league_settings
  for select to authenticated using (public.is_commissioner());

-- You can always see your own profile row (to know whether you've claimed);
-- members see everyone's.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (user_id = auth.uid() or public.is_member());

drop policy if exists polls_read on public.polls;
create policy polls_read on public.polls
  for select to authenticated using (public.is_member());

drop policy if exists polls_create on public.polls;
create policy polls_create on public.polls
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());

-- The creator (or the commissioner) can close or edit a poll.
drop policy if exists polls_update on public.polls;
create policy polls_update on public.polls
  for update to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_commissioner()))
  with check (public.is_member());

drop policy if exists polls_delete on public.polls;
create policy polls_delete on public.polls
  for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_commissioner()));

-- Who may see an individual vote row:
--   always your own vote;
--   everyone's votes on a "named" poll;
--   everyone's votes on an "anon_until_close" poll once it has closed;
--   never on an "anon" poll (totals come from poll_tallies instead).
drop policy if exists votes_read on public.votes;
create policy votes_read on public.votes
  for select to authenticated using (
    public.is_member() and (
      user_id = auth.uid()
      or exists (
        select 1 from public.polls p
        where p.id = votes.poll_id
          and (p.visibility = 'named'
               or (p.visibility = 'anon_until_close' and not public.poll_is_open(p)))
      )
    )
  );

drop policy if exists votes_cast on public.votes;
create policy votes_cast on public.votes
  for insert to authenticated with check (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.polls p where p.id = votes.poll_id and public.poll_is_open(p)
                and option_index < array_length(p.options, 1))
  );

drop policy if exists votes_change on public.votes;
create policy votes_change on public.votes
  for update to authenticated
  using (user_id = auth.uid()
         and exists (select 1 from public.polls p where p.id = votes.poll_id and public.poll_is_open(p)))
  with check (user_id = auth.uid()
         and exists (select 1 from public.polls p where p.id = votes.poll_id and public.poll_is_open(p)
                     and option_index < array_length(p.options, 1)));

grant usage on schema public to authenticated;
grant select on public.league_settings, public.profiles, public.claimed_teams, public.poll_tallies to authenticated;
grant select, insert, update, delete on public.polls to authenticated;
grant select, insert, update on public.votes to authenticated;
grant execute on function public.is_member(), public.is_commissioner(), public.claim_team(text, text),
  public.release_team(text), public.set_invite_code(text) to authenticated;
revoke all on public.league_settings, public.profiles, public.claimed_teams, public.polls, public.votes, public.poll_tallies from anon;
