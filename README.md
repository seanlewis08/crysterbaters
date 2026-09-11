# crysterbaters.com

League site for **League For Kids That Read Good** — a ten-team Yahoo fantasy basketball keeper league running since 2012.

Yahoo league ID `33689`. Site is currently a single static page; it becomes a full app once Yahoo Fantasy API access is approved.

## What's here

`index.html` — the whole site. No build step, no dependencies. Vercel serves it as-is. `players.json` is the one data file beside it (see Players below); `tools/players_snapshot.py` rebuilds it.

Pages: standings, teams and their locked rosters, a searchable player table (stats, fantasy value, salaries against the cap), the pre-draft board (with pick trades), the weekly games-cap calculator, the keeper calculator, league history with a season archive (Yahoo standings and full draft boards since 2019), polls, league dues, and the rules.

## Deploying

Vercel is connected to this repository. Pushing to `main` deploys automatically. Every other branch gets its own preview URL.

## League rules encoded in the site

**Keepers.** A player's keeper cost starts two rounds better than where he was drafted, and drops two more rounds for every season he's held. Waiver pickups enter the ladder at round 11. When the next cost would land past a first-round pick he is no longer keepable, which is why rounds 1 and 2 are locked the moment they're drafted. The cost belongs to the player, not the team — it follows him through trades and waiver claims. Two keepers per team, and each one costs that team its pick in that round.

**The roster lock.** Rosters lock before the playoffs, and that frozen roster decides keeper eligibility. A playoff team dropping a player afterwards does not lose him as a keeper. Yahoo does not preserve this snapshot, which is why it has historically lived as screenshots in a spreadsheet.

**Payout.** 50% to the champion, 40% to the runner-up, 10% to the regular-season winner (voted 2023). Dues are voted each preseason ($69 in 2024-25, $80 in 2025-26). Two keepers landing on the same round: the second moves one more round up (−2 and −3). Last place shoots 100 free throws in an hour on video. The champion holds the belt. All of this is on the Rules page under League Policies.

**Weekly games cap.** Thirty player-games a week, scaled down when the NBA plays a short week: `cap = 29.76 × (that week's league-wide games ÷ 50)`, rounded sensibly. Yahoo has no setting for this and cannot count it.

## Players

The Players page is every NBA player in one sortable table: age, games, minutes, the box-score line, our eleven categories, a **Value** column (sum of per-game z-scores across FG%, FT%, 3PTM, 3PT%, PTS, REB, AST, ST, BLK, A/T and DD, measured against the top 200 players by minutes — a player needs ten games to be ranked), Yahoo's default-formula fantasy points, who in the league had him when rosters locked (K for a flagged keeper), and his salary, share of the cap and years left. The cap, tax line, aprons and floor for the season sit above the table. Search is instant; filters cover NBA team, position, league ownership, per-game or totals, and season. Only the rows in view are in the DOM, so sorting 650 players is a few milliseconds.

Data: stats are fetched straight from ESPN's public feed in the browser (cached six hours, current season once it has games, otherwise last season). Salaries come from `players.json`, built by `python3 tools/players_snapshot.py` from Basketball-Reference's contracts page (one request; ESPN's contract feed fills gaps). Re-run it after free agency or big trades and commit the file; the page picks up the new snapshot on the next visit. Both sources are unofficial; if either changes, the page keeps showing the last snapshot.

## Logins and polls

Managers create an account on the site's **Claim Your Team** page: email, team, the league code the commissioner shares, a username and a password. The code is checked before the account is created and each team can be claimed once. Signing in is a small popup (email + password, with a forgot-password link). The commissioner — recognised by the email in `league_settings` — gets a **Manager** page nobody else sees, with the league code and the ten teams' claims (release a claim if someone picked wrong). Members can post polls, vote, and read the poll history; the poll's creator picks whether votes are shown with names, kept secret until the poll closes, or kept secret for good. Polls that happened in the group chat can be recorded into the history from the Manager page (choice, count and names per line); the September 2026 draft-time poll is seeded by the schema.

**Open Items** is the league's agenda: anyone signed in can raise something that needs deciding, everyone gets two thumbs-up to spend across the open list (take one back to move it), items sort by votes, "Put it to a vote" drops the item into a new poll, and the commissioner records the outcome. Two items are seeded by the schema (the in-person draft; a shorter season with dues pro-rated).

**League dues** live on their own page. The commissioner sets the season's amount, due date and where money goes (Venmo, Zelle, Cash App); each manager picks how they're paying — the page opens Venmo or Cash App with the amount filled in — and ticks "I've sent my dues". Only the commissioner's **Received** checkbox counts, and once it's ticked the manager's row is locked. Everyone can see who has settled up. Saving a new season label starts the next season and keeps the old one as history.

The backend is a free Supabase project: `supabase/schema.sql` creates the tables, the claim/release functions, and the row-level security rules (the visibility rules are enforced in the database, not just on the page). The project URL and publishable key live in `SB` near the bottom of `index.html`; off the real hostnames the Polls page runs in a browser-only preview mode. In Supabase, turn off "Confirm email" (Authentication → Sign In / Providers → Email) so sign-up needs no email.

## Still to come

Live standings and matchups, the automatic games-played counter, one-button roster lock, and eventually a chat. Those wait on Yahoo API access.
