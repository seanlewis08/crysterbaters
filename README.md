# crysterbaters.com

League site for **League For Kids That Read Good** — a ten-team Yahoo fantasy basketball keeper league running since 2012. Yahoo league ID `33689`.

Currently a single static page. It becomes a full app once Yahoo Fantasy API access is approved.

## What's here

`index.html` — the whole site. No build step, no dependencies. Vercel serves it as-is.

Pages: standings, teams and their locked rosters, the pre-draft board, the weekly games-cap calculator, the keeper calculator, league history, and the rules.

## Deploying

Vercel is connected to this repository. Pushing to `main` deploys automatically; every other branch gets its own preview URL.

## League rules encoded in the site

**Keepers.** A player's keeper cost starts two rounds better than where he was drafted and drops two more rounds for every season he is held. Waiver pickups enter the ladder at round 11. When the next cost would land past a first-round pick he is no longer keepable, which is why rounds 1 and 2 are locked the moment they're drafted. The cost belongs to the player, not the team — it follows him through trades and waiver claims. Two keepers per team, and each one costs that team its pick in that round.

**The roster lock.** Rosters lock before the playoffs, and that frozen roster decides keeper eligibility. A playoff team dropping a player afterwards does not lose him as a keeper. Yahoo does not preserve this snapshot, which is why it has historically lived as screenshots in a spreadsheet.

**Weekly games cap.** Thirty player-games a week, scaled down when the NBA plays a short week: `cap = 29.76 x (that week's league-wide games / 50)`, rounded sensibly. Yahoo has no setting for this and cannot count it.

## Still to come

Member logins, live standings and matchups, the automatic games-played counter, one-button roster lock, league polls, and eventually a chat. All of it waits on Yahoo API access.
