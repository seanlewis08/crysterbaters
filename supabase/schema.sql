-- League For Kids That Read Good — database for logins, polls and dues.
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: every statement is "if not exists" or "create or replace".
--
-- How membership works: managers sign up with email + password on the
-- site's Claim Your Team page, which checks the league code first, creates
-- the account, then claims one of the ten teams. Each team can be claimed
-- once. The commissioner can release a claim and change the code from the
-- site's Manager page. Turn OFF "Confirm email" under Authentication →
-- Sign In / Providers → Email so sign-up needs no email at all.

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
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  team_id      text not null unique check (team_id in
                 ('knuepp','claxton','rollins','george','rucker','ant','ysga','freaky','giannis','jalenba')),
  display_name text,
  created_at   timestamptz not null default now()
);
alter table public.profiles add column if not exists display_name text;

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

-- The sign-up page checks the code before it creates an account, so a
-- wrong code never leaves a stray login behind. Yes/no only.
create or replace function public.check_invite_code(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select upper(trim(p_code)) = upper(trim(s.invite_code)) from public.league_settings s where s.id = 1;
$$;

drop function if exists public.claim_team(text, text);
create or replace function public.claim_team(p_team_id text, p_code text, p_display_name text default null)
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
  insert into public.profiles (user_id, email, team_id, display_name)
    values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), p_team_id, nullif(trim(coalesce(p_display_name, '')), ''));
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
-- 4. League dues
-- ----------------------------------------------------------------------
-- One row per season. The commissioner sets the amount, the due date and
-- where to send money; saving a new season label starts a new season and
-- the old one stays behind as history. Exactly one season is "active".
create table if not exists public.dues_seasons (
  season     text primary key,
  amount     numeric(8,2) not null default 0 check (amount >= 0),
  due_date   date,
  venmo      text,
  zelle      text,
  cashapp    text,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per team per season. A manager marks how and whether they paid;
-- only the commissioner can flip "confirmed", which is what counts.
create table if not exists public.dues_payments (
  season       text not null references public.dues_seasons (season) on delete cascade,
  team_id      text not null check (team_id in
                 ('knuepp','claxton','rollins','george','rucker','ant','ysga','freaky','giannis','jalenba')),
  user_id      uuid references auth.users (id) on delete set null,
  method       text check (method in ('venmo','zelle','cashapp','cash','other')),
  paid         boolean not null default false,
  paid_at      timestamptz,
  note         text,
  confirmed    boolean not null default false,
  confirmed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (season, team_id)
);

create or replace function public.dues_set_season(
  p_season text, p_amount numeric, p_due_date date,
  p_venmo text default null, p_zelle text default null, p_cashapp text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_season text := trim(coalesce(p_season, ''));
begin
  if not public.is_commissioner() then raise exception 'Commissioner only.'; end if;
  if length(v_season) < 2 then raise exception 'Give the season a name, like 2025-26.'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the dues amount.'; end if;
  insert into public.dues_seasons (season, amount, due_date, venmo, zelle, cashapp, note, active)
    values (v_season, p_amount, p_due_date,
            nullif(trim(coalesce(p_venmo, '')), ''), nullif(trim(coalesce(p_zelle, '')), ''),
            nullif(trim(coalesce(p_cashapp, '')), ''), nullif(trim(coalesce(p_note, '')), ''), true)
  on conflict (season) do update set
    amount = excluded.amount, due_date = excluded.due_date, venmo = excluded.venmo, zelle = excluded.zelle,
    cashapp = excluded.cashapp, note = excluded.note, active = true, updated_at = now();
  update public.dues_seasons set active = false where season <> v_season and active;
end $$;

-- A manager records their own team's payment. Locked once the commissioner
-- has confirmed it.
create or replace function public.dues_mark(p_season text, p_method text, p_paid boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_team text; v_row public.dues_payments;
begin
  select team_id into v_team from public.profiles where user_id = auth.uid();
  if v_team is null then raise exception 'Claim your team first.'; end if;
  if not exists (select 1 from public.dues_seasons where season = p_season) then raise exception 'That season isn''t set up.'; end if;
  select * into v_row from public.dues_payments where season = p_season and team_id = v_team;
  if v_row.confirmed then raise exception 'Sean already confirmed this payment — talk to him if something''s off.'; end if;
  insert into public.dues_payments (season, team_id, user_id, method, paid, paid_at, note)
    values (p_season, v_team, auth.uid(), p_method, coalesce(p_paid, false),
            case when p_paid then now() end, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (season, team_id) do update set
    user_id = auth.uid(), method = excluded.method, paid = excluded.paid,
    paid_at = case when excluded.paid then coalesce(public.dues_payments.paid_at, now()) end,
    note = excluded.note, updated_at = now();
end $$;

-- The commissioner confirms money actually arrived (or un-confirms).
create or replace function public.dues_confirm(p_season text, p_team_id text, p_confirmed boolean, p_method text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commissioner() then raise exception 'Commissioner only.'; end if;
  insert into public.dues_payments (season, team_id, method, paid, paid_at, confirmed, confirmed_at)
    values (p_season, p_team_id, p_method, p_confirmed, case when p_confirmed then now() end, p_confirmed, case when p_confirmed then now() end)
  on conflict (season, team_id) do update set
    method = coalesce(excluded.method, public.dues_payments.method),
    paid = case when excluded.confirmed then true else public.dues_payments.paid end,
    paid_at = case when excluded.confirmed then coalesce(public.dues_payments.paid_at, now()) else public.dues_payments.paid_at end,
    confirmed = excluded.confirmed,
    confirmed_at = case when excluded.confirmed then now() end,
    updated_at = now();
end $$;

-- ----------------------------------------------------------------------
-- 5. Row-level security
-- ----------------------------------------------------------------------
alter table public.league_settings enable row level security;
alter table public.profiles        enable row level security;
alter table public.polls           enable row level security;
alter table public.votes           enable row level security;
alter table public.dues_seasons    enable row level security;
alter table public.dues_payments   enable row level security;

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

-- Dues: every member can read the season settings and everyone's status;
-- all writes go through dues_set_season / dues_mark / dues_confirm.
drop policy if exists dues_seasons_read on public.dues_seasons;
create policy dues_seasons_read on public.dues_seasons
  for select to authenticated using (public.is_member());
drop policy if exists dues_payments_read on public.dues_payments;
create policy dues_payments_read on public.dues_payments
  for select to authenticated using (public.is_member());

grant usage on schema public to authenticated;
grant select on public.league_settings, public.profiles, public.claimed_teams, public.poll_tallies to authenticated;
grant select on public.claimed_teams to anon;   -- team ids only, so the sign-up page can grey out taken teams
grant select, insert, update, delete on public.polls to authenticated;
grant select, insert, update on public.votes to authenticated;
grant select on public.dues_seasons, public.dues_payments to authenticated;
grant execute on function public.is_member(), public.is_commissioner(), public.claim_team(text, text, text),
  public.release_team(text), public.set_invite_code(text),
  public.dues_set_season(text, numeric, date, text, text, text, text), public.dues_mark(text, text, boolean, text),
  public.dues_confirm(text, text, boolean, text) to authenticated;
grant execute on function public.check_invite_code(text) to anon, authenticated;
revoke all on public.league_settings, public.profiles, public.polls, public.votes, public.poll_tallies,
  public.dues_seasons, public.dues_payments from anon;
