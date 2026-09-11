-- League For Kids That Read Good — database for logins and polls.
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: every statement is "if not exists" or "create or replace".

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------
-- 1. Members: the only ten email addresses allowed to sign in.
--    Fill in the real addresses below (lower-case). team_id must match the
--    ids used in index.html.
-- ----------------------------------------------------------------------
create table if not exists public.members (
  email           text primary key,
  manager         text not null,
  team_id         text not null,
  is_commissioner boolean not null default false
);

insert into public.members (email, manager, team_id, is_commissioner) values
  ('seanlewis08@gmail.com',      'Sean Lewis',            'jalenba', true),
  ('ben@example.com',            'Ben Zavelsky',          'knuepp',  false),
  ('anush@example.com',          'Anush Rohani-Shukla',   'claxton', false),
  ('david@example.com',          'David Zavelsky',        'rollins', false),
  ('abada@example.com',          'Jon Abada',             'george',  false),
  ('tyler@example.com',          'Tyler Brown',           'rucker',  false),
  ('gonzo@example.com',          'Jonathan Gonzalez',     'ant',     false),
  ('chris@example.com',          'Chris Kestle',          'ysga',    false),
  ('rajat@example.com',          'Rajat Khanna',          'freaky',  false),
  ('kabir@example.com',          'Kabir Sodhi',           'giannis', false)
on conflict (email) do update
  set manager = excluded.manager, team_id = excluded.team_id, is_commissioner = excluded.is_commissioner;

-- Block anyone who is not on the list from creating an account, even if
-- they request a magic link. The site shows a friendly message when this fires.
create or replace function public.only_members_may_join()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.members m where lower(m.email) = lower(new.email)) then
    raise exception 'not a league member';
  end if;
  return new;
end $$;

drop trigger if exists only_members_may_join on auth.users;
create trigger only_members_may_join
  before insert on auth.users
  for each row execute function public.only_members_may_join();

-- Helper used by the policies below.
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.is_commissioner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select m.is_commissioner from public.members m
                   where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))), false);
$$;

-- ----------------------------------------------------------------------
-- 2. Polls
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
-- 3. Row-level security
-- ----------------------------------------------------------------------
alter table public.members enable row level security;
alter table public.polls   enable row level security;
alter table public.votes   enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (public.is_member());

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
grant select on public.members, public.poll_tallies to authenticated;
grant select, insert, update, delete on public.polls to authenticated;
grant select, insert, update on public.votes to authenticated;
revoke all on public.members, public.polls, public.votes, public.poll_tallies from anon;
