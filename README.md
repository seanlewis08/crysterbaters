# crysterbaters.com

League site for **League For Kids That Read Good** — a ten-team Yahoo fantasy basketball keeper league running since 2012.

Yahoo league ID `33689`. Site is currently a single static page; it becomes a full app once Yahoo Fantasy API access is approved.

## What's here

`index.html` — the whole site. No build step, no dependencies. Vercel serves it as-is.

Pages: standings, teams and their locked rosters, the pre-draft board (with pick trades), the weekly games-cap calculator, the keeper calculator, league history with a season archive (Yahoo standings and full draft boards since 2019), polls, and the rules.

## Deploying

Vercel is connected to this repository. Pushing to `main` deploys automatically. Every other branch gets its own preview URL.

## League rules encoded in the site

**Keepers.** A player's keeper cost starts two rounds better than where he was drafted, and drops two more rounds for every season he's held. Waiver pickups enter the ladder at round 11. When the next cost would land past a first-round pick he is no longer keepable, which is why rounds 1 and 2 are locked the moment they're drafted. The cost belongs to the player, not the team — it follows him through trades and waiver claims. Two keepers per team, and each one costs that team its pick in that round.

**The roster lock.** Rosters lock before the playoffs, and that frozen roster decides keeper eligibility. A playoff team dropping a player afterwards does not lose him as a keeper. Yahoo does not preserve this snapshot, which is why it has historically lived as screenshots in a spreadsheet.

**Weekly games cap.** Thirty player-games a week, scaled down when the NBA plays a short week: `cap = 29.76 × (that week's league-wide games ÷ 50)`, rounded sensibly. Yahoo has no setting for this and cannot count it.

## Logins and polls

Members sign in with a magic link sent to their email (no passwords). The first time in, they pick their team from the ten and enter the league code the commissioner shares; each team can be claimed once, and the commissioner can release a claim or change the code from the site. Members can post polls, vote, and read the poll history. The poll's creator picks whether votes are shown with names, kept secret until the poll closes, or kept secret for good.

The backend is a free Supabase project: `supabase/schema.sql` creates the tables, the claim/release functions, and the row-level security rules (the visibility rules are enforced in the database, not just on the page). To switch it on, set `SB.url` and `SB.anon` near the bottom of `index.html` to the project's URL and anon (public) key. With both empty the Polls page runs in a preview mode that lives only in the visitor's browser.

## Still to come

Live standings and matchups, the automatic games-played counter, one-button roster lock, and eventually a chat. Those wait on Yahoo API access.
