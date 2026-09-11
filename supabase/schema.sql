-- League For Kids That Read Good — database for logins, polls, open items and dues.
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

-- Polls that happened somewhere else (WhatsApp, the group chat) and were
-- recorded afterwards by the commissioner: no vote rows, just the result.
-- results = {"counts":[..], "voters":[["Sean","Ben"],..], "voted":7, "multi":true, "source":"WhatsApp"}
alter table public.polls add column if not exists imported boolean not null default false;
alter table public.polls add column if not exists asked_on date;
alter table public.polls add column if not exists results jsonb;

-- The draft-time poll from the group chat, 10 Sep 2026 (owned by the commissioner's login).
insert into public.polls (question, options, visibility, closed, created_by, created_by_email, created_at, imported, asked_on, results)
select 'Draft Time (Oct 18)',
       array['10 am PST (1pm EST)','12pm PST (3pm EST)','2pm PST (5pm EST)','4pm PST (7 PM EST)','6pm PST (9 PM EST)','8pm PST (11 PM EST)'],
       'named', true, u.id, u.email, '2026-09-10 09:23:00-07', true, '2026-09-10',
       '{"multi":true,"source":"WhatsApp","voted":7,"counts":[5,7,6,6,3,2],
         "voters":[["Chris","David","Anush","Ben","Gonzo"],
                   ["Sean","Chris","David","Anush","Ben","Gonzo","Kabir"],
                   ["Sean","David","Anush","Ben","Gonzo","Kabir"],
                   ["Sean","David","Anush","Ben","Gonzo","Kabir"],
                   ["Anush","Ben","Gonzo"],
                   ["Anush","Ben"]]}'::jsonb
from auth.users u
where lower(u.email) = (select lower(commissioner_email) from public.league_settings where id = 1)
  and not exists (select 1 from public.polls where imported and question = 'Draft Time (Oct 18)');

-- Every poll from the group chat since 2024 (counts only — WhatsApp exports don't say who voted).
insert into public.polls (question, options, visibility, closed, created_by, created_by_email, created_at, imported, asked_on, results)
select v.question, v.options, 'named', true, u.id, u.email, v.created_at, true, v.asked_on, v.results
from (values
  ('Who u want to win', array['Mavs','Jason Tatum']::text[], timestamptz '2024-06-02 18:30:00-07', date '2024-06-02', '{"multi": false, "source": "WhatsApp", "voted": 3, "counts": [3, 0], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Why do dislike the Cs', array['Fuck the Celtics in general','I dont like Jason Tatum','I dont like 1 or more of the other guys','Itd be funny if they lose','I root for a close competitor of theirs']::text[], timestamptz '2024-06-02 18:31:00-07', date '2024-06-02', '{"multi": true, "source": "WhatsApp", "voted": 8, "counts": [8, 4, 2, 6, 1], "voters": [[], [], [], [], []], "asked_by": "Kabir"}'::jsonb),
  ('Finals winner', array['Celtics in 4','Celtics in 5','Celtics in 6','Celtics in 7','Mavs in 4','Mavs in 5','Mavs in 6','Mavs in 7']::text[], timestamptz '2024-06-05 08:14:00-07', date '2024-06-05', '{"multi": false, "source": "WhatsApp", "voted": 7, "counts": [0, 0, 1, 1, 0, 0, 2, 3], "voters": [[], [], [], [], [], [], [], []], "asked_by": "Abada"}'::jsonb),
  ('Draft', array['September','October']::text[], timestamptz '2024-08-19 19:32:00-07', date '2024-08-19', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [0, 6], "voters": [[], []], "asked_by": "Sean"}'::jsonb),
  ('Draft Day', array['Sat Oct 5','Sun Oct 6','Sat Oct 12','Sun Oct 13','Sat Oct 19','Sun Oct 20']::text[], timestamptz '2024-08-22 02:08:00-07', date '2024-08-22', '{"multi": true, "source": "WhatsApp", "voted": 6, "counts": [0, 3, 2, 5, 4, 6], "voters": [[], [], [], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('Oct 20 Draft day time', array['Morning (9am PST/12pm EST)','Afternoon (12pm PST/3pmEST)','Evening (5pm PST/8pmEST)','Night (7pm PST/10pm EST)','A different time PST Only','A different time EST only']::text[], timestamptz '2024-08-30 07:21:00-07', date '2024-08-30', '{"multi": true, "source": "WhatsApp", "voted": 5, "counts": [2, 0, 5, 5, 1, 1], "voters": [[], [], [], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('Buy In (2)', array['50','75','100','69']::text[], timestamptz '2024-09-17 08:13:00-07', date '2024-09-17', '{"multi": true, "source": "WhatsApp", "voted": 5, "counts": [2, 2, 4, 5], "voters": [[], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('IR slots', array['1','2','Buckle my shoe']::text[], timestamptz '2024-10-22 10:08:00-07', date '2024-10-22', '{"multi": false, "source": "WhatsApp", "voted": 10, "counts": [5, 5, 0], "voters": [[], [], []], "asked_by": "Sean"}'::jsonb),
  ('Games Election Week', array['25','27','30']::text[], timestamptz '2024-11-03 21:03:00-07', date '2024-11-03', '{"multi": false, "source": "WhatsApp", "voted": 7, "counts": [1, 5, 1], "voters": [[], [], []], "asked_by": "Sean"}'::jsonb),
  ('How should we handle keepers drafted in the same position?', array['1st keeper -2 rounds; 2nd keeper -3 rounds','1st keeper -2 rounds; 2nd keeper -4 rounds']::text[], timestamptz '2025-02-20 16:51:00-07', date '2025-02-20', '{"multi": false, "source": "WhatsApp", "voted": 9, "counts": [9, 0], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Belt images', array['Jrue Holiday','Cartoon picture','Duncan Jorts','D rose','AI generated']::text[], timestamptz '2025-03-12 10:31:00-07', date '2025-03-12', '{"multi": false, "source": "WhatsApp", "voted": 9, "counts": [0, 0, 5, 4, 0], "voters": [[], [], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('East - 7th vs 8th', array['Hawks','Magic']::text[], timestamptz '2025-04-15 06:54:00-07', date '2025-04-15', '{"multi": false, "source": "WhatsApp", "voted": 5, "counts": [2, 3], "voters": [[], []], "asked_by": "Anush"}'::jsonb),
  ('West - 7th vs 8th', array['Grizzlies','Warriors']::text[], timestamptz '2025-04-15 06:54:00-07', date '2025-04-15', '{"multi": false, "source": "WhatsApp", "voted": 5, "counts": [1, 4], "voters": [[], []], "asked_by": "Anush"}'::jsonb),
  ('Who?', array['Heat','Bulls']::text[], timestamptz '2025-04-16 10:36:00-07', date '2025-04-16', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [2, 2], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who?', array['Mavs','Kings']::text[], timestamptz '2025-04-16 10:36:00-07', date '2025-04-16', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [2, 2], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins the series', array['Bucks','Pacers']::text[], timestamptz '2025-04-19 09:15:00-07', date '2025-04-19', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [4, 2], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins series', array['Clippers','Nuggies']::text[], timestamptz '2025-04-19 09:16:00-07', date '2025-04-19', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [2, 4], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins series', array['Pistons','Knicks']::text[], timestamptz '2025-04-19 09:16:00-07', date '2025-04-19', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [2, 4], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who winz seriez', array['Wolves','Lakers']::text[], timestamptz '2025-04-19 09:16:00-07', date '2025-04-19', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [2, 4], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins Round 2', array['Nugs','Thunder']::text[], timestamptz '2025-05-06 14:24:00-07', date '2025-05-06', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [2, 2], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins Round 2', array['Warriors','Wolves']::text[], timestamptz '2025-05-06 14:24:00-07', date '2025-05-06', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [0, 4], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins Round 2 East', array['Knicks','Celtikkks']::text[], timestamptz '2025-05-06 14:25:00-07', date '2025-05-06', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [4, 0], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins Round 2 East', array['Cavs','Pacers']::text[], timestamptz '2025-05-06 14:25:00-07', date '2025-05-06', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [3, 1], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Winner ECF', array['Pacers','Knicks']::text[], timestamptz '2025-05-16 20:17:00-07', date '2025-05-16', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [1, 3], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins WCF', array['Wolves','Thunder']::text[], timestamptz '2025-05-18 17:20:00-07', date '2025-05-18', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [3, 3], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Who wins 2025 Finals', array['Pacers','Thunder']::text[], timestamptz '2025-06-01 10:40:00-07', date '2025-06-01', '{"multi": false, "source": "WhatsApp", "voted": 9, "counts": [1, 8], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('Over/under 3.5 trades today', array['Over','Under']::text[], timestamptz '2025-06-25 06:17:00-07', date '2025-06-25', '{"multi": false, "source": "WhatsApp", "voted": 4, "counts": [3, 1], "voters": [[], []], "asked_by": "Abada"}'::jsonb),
  ('Buy in', array['70','80','90','100']::text[], timestamptz '2025-09-03 20:55:00-07', date '2025-09-03', '{"multi": false, "source": "WhatsApp", "voted": 6, "counts": [0, 6, 0, 0], "voters": [[], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('Updated Draft Day Poll', array['October 4 (Saturday) [Keepers 9/27]','October 5 (Sunday) [Keepers 9/28]','October 11 (Saturday) [Keepers 10/4]','October 12 (Sunday) [Keepers 10/5]','October 18 (Saturday) [Keepers 10/11]','October 19 (Sunday) [Keepers 10/12]']::text[], timestamptz '2025-09-04 12:53:00-07', date '2025-09-04', '{"multi": true, "source": "WhatsApp", "voted": 8, "counts": [0, 2, 1, 3, 3, 8], "voters": [[], [], [], [], [], []], "asked_by": "Sean"}'::jsonb),
  ('TO or A/TO', array['TO','ATO']::text[], timestamptz '2025-09-07 19:01:00-07', date '2025-09-07', '{"multi": false, "source": "WhatsApp", "voted": 5, "counts": [4, 1], "voters": [[], []], "asked_by": "Kabir"}'::jsonb),
  ('What time for draft on Sunday 10/19', array['2pm EST','3pm EST','4pm EST','5pm EST','6pm EST','7pm EST','8pm EST','9pm EST']::text[], timestamptz '2025-10-03 13:35:00-07', date '2025-10-03', '{"multi": true, "source": "WhatsApp", "voted": 7, "counts": [2, 2, 2, 4, 7, 2, 2, 2], "voters": [[], [], [], [], [], [], [], []], "asked_by": "Kabir"}'::jsonb),
  ('Last place punishment', array['12 hours in a waffle house - 1 hour per waffle/pancake','Make 100 free throws in an hour','Beer Mile','Perform at an Open Mic','Join the National Guard']::text[], timestamptz '2025-10-15 17:00:00-07', date '2025-10-15', '{"multi": true, "source": "WhatsApp", "voted": 5, "counts": [3, 5, 1, 3, 3], "voters": [[], [], [], [], []], "asked_by": "Kabir"}'::jsonb),
  ('Games played Limit Week 8', array['Increase to 17','Leave at 15']::text[], timestamptz '2025-12-08 04:13:00-07', date '2025-12-08', '{"multi": false, "source": "WhatsApp", "voted": 9, "counts": [0, 9], "voters": [[], []], "asked_by": "Sean"}'::jsonb),
  ('Week 9 GP Limit', array['20','25']::text[], timestamptz '2025-12-13 18:45:00-07', date '2025-12-13', '{"multi": false, "source": "WhatsApp", "voted": 9, "counts": [3, 6], "voters": [[], []], "asked_by": "Sean"}'::jsonb),
  ('Week 17 Pickup Limit', array['4 (Current)','5']::text[], timestamptz '2026-02-10 16:22:00-07', date '2026-02-10', '{"multi": false, "source": "WhatsApp", "voted": 8, "counts": [2, 6], "voters": [[], []], "asked_by": "Sean"}'::jsonb)
) as v(question, options, created_at, asked_on, results)
join auth.users u on lower(u.email) = (select lower(commissioner_email) from public.league_settings where id = 1)
where not exists (select 1 from public.polls p where p.imported and p.question = v.question and p.asked_on = v.asked_on and p.options[1] = v.options[1]);

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
-- 3b. Open items: things the league still has to decide
-- ----------------------------------------------------------------------
create table if not exists public.agenda (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (length(title) between 3 and 140),
  details          text,
  status           text not null default 'open' check (status in ('open', 'decided')),
  outcome          text,
  created_by       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);

-- The two items carried over from the 2026 offseason, owned by the commissioner's login.
insert into public.agenda (title, details, created_by, created_by_email, created_at)
select v.title, v.details, u.id, u.email, v.created_at
from (values
  ('In-person draft', 'Plan a weekend around the draft: a location vote (DC was leading), Sunday draft at a Buffalo Wild Wings, competitions the day before. Pushed to 2027.', timestamptz '2026-03-29 18:48:00-07'),
  ('Shorter season, dues pro-rated', 'Cut the season length and reduce the buy-in in proportion. Raised at the end of 2025-26; needs a vote before it changes anything.', timestamptz '2026-03-29 18:49:00-07')
) as v(title, details, created_at)
join auth.users u on lower(u.email) = (select lower(commissioner_email) from public.league_settings where id = 1)
where not exists (select 1 from public.agenda a where a.title = v.title);

-- Priority votes: each manager gets two thumbs-up to spend across the open
-- items, and can take one back to move it. Votes on decided items don't count.
create table if not exists public.agenda_votes (
  item_id    uuid not null references public.agenda (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  voter_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

create or replace function public.agenda_vote(p_item uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_used int;
begin
  if not public.is_member() then raise exception 'Claim your team first.'; end if;
  if p_on then
    if not exists (select 1 from public.agenda where id = p_item and status = 'open') then raise exception 'That item is closed.'; end if;
    select count(*) into v_used from public.agenda_votes v join public.agenda a on a.id = v.item_id
      where v.user_id = auth.uid() and a.status = 'open' and v.item_id <> p_item;
    if v_used >= 2 then raise exception 'You''ve used both votes — take one back first.'; end if;
    insert into public.agenda_votes (item_id, user_id) values (p_item, auth.uid()) on conflict do nothing;
  else
    delete from public.agenda_votes where item_id = p_item and user_id = auth.uid();
  end if;
end $$;

-- ----------------------------------------------------------------------
-- 3c. Scheduling: when can everyone make the draft?
-- ----------------------------------------------------------------------
-- The commissioner opens an event with candidate dates and an hour range
-- (in his time zone); every manager marks the hours they're free. Slots are
-- stored as UTC instants so each person sees the grid in their own zone.
create table if not exists public.avail_events (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(title) between 2 and 80),
  dates      date[] not null check (array_length(dates, 1) between 1 and 14),
  start_hour int not null default 9 check (start_hour between 0 and 23),
  end_hour   int not null default 21 check (end_hour between 1 and 24),
  tz         text not null default 'America/Los_Angeles',
  status     text not null default 'open' check (status in ('open', 'closed')),
  chosen     text,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.avail_marks (
  event_id    uuid not null references public.avail_events (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  voter_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  slots       text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- The 2026 draft: Oct 11 through Oct 19, 9am–10pm Pacific (Sean's call).
insert into public.avail_events (title, dates, start_hour, end_hour, tz, created_by)
select '2026 Draft', array['2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18','2026-10-19']::date[], 9, 22, 'America/Los_Angeles', u.id
from auth.users u
where lower(u.email) = (select lower(commissioner_email) from public.league_settings where id = 1)
  and not exists (select 1 from public.avail_events);

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
alter table public.agenda          enable row level security;
alter table public.agenda_votes    enable row level security;
alter table public.avail_events    enable row level security;
alter table public.avail_marks     enable row level security;
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

-- Open items: members read and add; the person who raised one, or the
-- commissioner, can mark it decided or delete it.
drop policy if exists agenda_read on public.agenda;
create policy agenda_read on public.agenda for select to authenticated using (public.is_member());
drop policy if exists agenda_add on public.agenda;
create policy agenda_add on public.agenda for insert to authenticated with check (public.is_member() and created_by = auth.uid());
drop policy if exists agenda_update on public.agenda;
create policy agenda_update on public.agenda for update to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_commissioner()))
  with check (public.is_member());
drop policy if exists agenda_delete on public.agenda;
create policy agenda_delete on public.agenda for delete to authenticated
  using (public.is_member() and (created_by = auth.uid() or public.is_commissioner()));

drop policy if exists agenda_votes_read on public.agenda_votes;
create policy agenda_votes_read on public.agenda_votes for select to authenticated using (public.is_member());

-- Scheduling: members read events and everyone's marks; only the commissioner
-- opens or closes an event; each manager writes only their own marks.
drop policy if exists avail_events_read on public.avail_events;
create policy avail_events_read on public.avail_events for select to authenticated using (public.is_member());
drop policy if exists avail_events_write on public.avail_events;
create policy avail_events_write on public.avail_events for insert to authenticated with check (public.is_commissioner() and created_by = auth.uid());
drop policy if exists avail_events_update on public.avail_events;
create policy avail_events_update on public.avail_events for update to authenticated using (public.is_commissioner()) with check (public.is_commissioner());
drop policy if exists avail_events_delete on public.avail_events;
create policy avail_events_delete on public.avail_events for delete to authenticated using (public.is_commissioner());
drop policy if exists avail_marks_read on public.avail_marks;
create policy avail_marks_read on public.avail_marks for select to authenticated using (public.is_member());
drop policy if exists avail_marks_write on public.avail_marks;
create policy avail_marks_write on public.avail_marks for insert to authenticated with check (public.is_member() and user_id = auth.uid());
drop policy if exists avail_marks_update on public.avail_marks;
create policy avail_marks_update on public.avail_marks for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

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
grant select, insert, update, delete on public.agenda to authenticated;
grant select on public.agenda_votes to authenticated;
grant select, insert, update, delete on public.avail_events to authenticated;
grant select, insert, update on public.avail_marks to authenticated;
grant select on public.dues_seasons, public.dues_payments to authenticated;
grant execute on function public.is_member(), public.is_commissioner(), public.claim_team(text, text, text),
  public.release_team(text), public.set_invite_code(text),
  public.dues_set_season(text, numeric, date, text, text, text, text), public.dues_mark(text, text, boolean, text),
  public.dues_confirm(text, text, boolean, text), public.agenda_vote(uuid, boolean) to authenticated;
grant execute on function public.check_invite_code(text) to anon, authenticated;
revoke all on public.league_settings, public.profiles, public.polls, public.votes, public.poll_tallies,
  public.agenda, public.agenda_votes, public.avail_events, public.avail_marks, public.dues_seasons, public.dues_payments from anon;
