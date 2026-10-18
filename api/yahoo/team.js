// The signed-in manager's own team in league 33689, this week, read live from Yahoo.
// The response is marked no-store. The one thing kept is the day-by-day lineup it
// just read, written to the games ledger (lineup_days) so the team's page shows the
// same days to everyone else; see _lib/ledger.js.
const L = require("./_lib");
const BENCH = { BN: 1, IL: 1, "IL+": 1, IR: 1, NA: 1 };
const list = v => Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
module.exports = async (req, res) => {
  try {
    const s = await L.session(req, res);
    if (!s) return L.json(res, 401, { error: "not_connected", why: res.cbWhy || "", v: 2 });
    // ?season=2025&week=10 looks at a past week (the league keeps its ID across seasons; if not,
    // the one team this login had that season is taken); ?days=1 adds the lineup for each day
    const q = new URL(req.url, L.origin(req)).searchParams;
    const wantSeason = q.get("season") || "", wantWeek = Number(q.get("week")) || 0, wantDays = q.get("days") !== "0";
    // every NBA team this login owns, newest season first
    const games = L.fold((await L.yahoo(s, "/users;use_login=1/games;game_codes=nba/teams")).fantasy_content.users)[0].user.games;
    let team = null, game = null;
    list(games).slice().reverse().some(g => {
      const gg = g.game; const teams = list(gg.teams).map(x => x.team).filter(Boolean);
      if (wantSeason && String(gg.season) !== wantSeason) return false;
      const t = teams.find(x => (x.team_key || "").indexOf(".l." + L.LEAGUE_ID + ".") > 0) || (wantSeason && teams.length === 1 ? teams[0] : null);
      if (t) { team = t; game = gg; return true; } return false;
    });
    if (!team) {
      // say what Yahoo did return (this login's own seasons and team keys) so a renewed league's new ID is easy to spot
      const seen = list(games).map(g => {
        const gg = (g && g.game) || {};
        const ts = list(gg.teams).map(x => x && x.team ? (x.team.team_key + " " + (x.team.name || "")) : JSON.stringify(x).slice(0, 80));
        return (gg.season || "?") + ": " + (ts.join(", ") || "no teams");
      });
      return L.json(res, 404, { error: "no_team", detail: "This Yahoo account has no team in league " + L.LEAGUE_ID + ". Yahoo returned — " + (seen.join(" | ") || "no NBA seasons") });
    }
    const key = team.team_key, lk = key.replace(/\.t\.\d+$/, "");
    let warnDraft = "";
    const league = L.fold((await L.yahoo(s, "/league/" + lk)).fantasy_content.league);
    const curWeek = Number(league.current_week) || 1, startWeek = Number(league.start_week) || 1, endWeek = Number(league.end_week) || curWeek;
    const week = Math.min(Math.max(wantWeek || curWeek, startWeek), endWeek);

    // this season's draft, so each player's keeper cost follows the pick that actually bought him
    // (round − 2; rounds 1–2 can't be kept; an undrafted pickup is a round-11 keeper)
    let draft = {}, draftDone = false;
    try {
      const dr = L.fold((await L.yahoo(s, "/league/" + lk + "/draftresults")).fantasy_content.league);
      list(dr.draft_results).map(x => x.draft_result || x).forEach(d => { if (d && d.player_key) draft[d.player_key] = { round: Number(d.round) || 0, pick: Number(d.pick) || 0, team: d.team_key || "" }; });
      draftDone = Object.keys(draft).length > 0;
    } catch (e) { warnDraft = e.message; }

    // roster with this week's games played
    const roster = L.fold((await L.yahoo(s, "/team/" + key + "/roster;week=" + week + "/players/stats;type=week;week=" + week)).fantasy_content.team);
    const ro = roster.roster || {};
    const players = list(ro.players || (ro["0"] && ro["0"].players)).map(p => {
      const pl = p.player || p;
      const stats = list(pl.player_stats && pl.player_stats.stats).map(x => x.stat || x);
      const gp = stats.find(x => String(x.stat_id) === "0");
      const elig = list(pl.eligible_positions).map(x => (x && x.position) || x).filter(x => typeof x === "string");
      return {
        key: pl.player_key, name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.selected_position && pl.selected_position.position,
        elig: elig, status: pl.status || "", note: pl.injury_note || pl.status_full || "",
        gp: gp ? Number(gp.value) || 0 : 0,
        draft: draft[pl.player_key] || null
      };
    });
    const activeP = players.filter(p => !BENCH[p.pos]), benchP = players.filter(p => p.pos === "BN"), ilP = players.filter(p => BENCH[p.pos] && p.pos !== "BN");
    const gamesOut = { active: activeP.reduce((a, p) => a + p.gp, 0), cap: 30, bench: players.filter(p => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0) };

    // standings and this week's matchup are extras: a hiccup there must not hide the roster
    let standing = null, matchup = null, warn = [];
    if (warnDraft) warn.push("draft: " + warnDraft);
    try {
      const st = L.fold((await L.yahoo(s, "/team/" + key + "/standings")).fantasy_content.team);
      const ts = st.team_standings || {}, ot = ts.outcome_totals || {};
      standing = { rank: Number(ts.rank) || null, wins: Number(ot.wins) || 0, losses: Number(ot.losses) || 0, ties: Number(ot.ties) || 0, pct: ot.percentage || "", seed: ts.playoff_seed || null };
    } catch (e) { warn.push("standings: " + e.message); }
    try {
      const mt = L.fold((await L.yahoo(s, "/team/" + key + "/matchups;weeks=" + week)).fantasy_content.team);
      const m = list(mt.matchups).map(x => x.matchup || x)[0];
      if (m) {
        const sides = list(m.teams || (m["0"] && m["0"].teams)).map(x => x.team || x);
        const opp = sides.find(x => x.team_key !== key) || {};
        const winners = list(m.stat_winners).map(x => x.stat_winner || x);
        const won = winners.filter(x => x.winner_team_key === key).length, tied = winners.filter(x => String(x.is_tied) === "1").length;
        matchup = { week: Number(m.week) || week, status: m.status || "", start: m.week_start || "", end: m.week_end || "", opponent: opp.name || "", opponentKey: opp.team_key || "", won: won, lost: winners.length - won - tied, tied: tied, cats: winners.length };
      }
    } catch (e) { warn.push("matchup: " + e.message); }

    // the lineup Yahoo holds for each day of the week, with that day's games played: past days are
    // what actually counted, today and later are the lineups as set now
    // the week's dates: from the matchup when Yahoo gives them, else from the league's start date
    // (week 1 runs opening day to the following Sunday; every later week is Monday to Sunday)
    let wkStart = matchup && matchup.start, wkEnd = matchup && matchup.end;
    if (!(wkStart && wkEnd) && league.start_date) {
      const s0 = new Date(league.start_date + "T12:00:00Z");
      const sun1 = new Date(s0); sun1.setUTCDate(sun1.getUTCDate() + ((7 - sun1.getUTCDay()) % 7));
      if (week <= 1) { wkStart = s0.toISOString().slice(0, 10); wkEnd = sun1.toISOString().slice(0, 10); }
      else { const a = new Date(sun1); a.setUTCDate(a.getUTCDate() + 1 + 7 * (week - 2)); const b = new Date(a); b.setUTCDate(b.getUTCDate() + 6); wkStart = a.toISOString().slice(0, 10); wkEnd = b.toISOString().slice(0, 10); }
      if (matchup) { matchup.start = matchup.start || wkStart; matchup.end = matchup.end || wkEnd; }
      warn.push("week dates derived from the league start (matchup carried none)");
    }
    let days = null;
    if (wantDays && wkStart && wkEnd) {
      days = [];
      const d0 = new Date(wkStart + "T12:00:00Z"), d1 = new Date(wkEnd + "T12:00:00Z");
      const dates = [];
      for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
      // the league context only returns the scoring categories (no GP), so each day's lineup
      // comes from the roster and "did he play" from the game-wide player stats for that date
      const got = await Promise.all(dates.map(date =>
        // Yahoo only honours the date when the coverage type is given too; a bare
        // ";date=" is ignored and today's roster comes back for every day
        L.yahoo(s, "/team/" + key + "/roster;type=date;date=" + date + "/players")
          .then(j => L.fold(j).fantasy_content.team).catch(e => ({ _err: e.message }))));
      let rawDay = null;
      for (let i = 0; i < got.length; i++) {
        const t = got[i];
        if (t._err) { days.push({ date: dates[i], error: t._err }); continue; }
        const r = t.roster || {};
        const ps = list(r.players || (r["0"] && r["0"].players)).map(p => {
          const pl = p.player || p;
          return { key: pl.player_key, name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.selected_position && pl.selected_position.position, status: pl.status || "", gp: 0 };
        });
        let dayErr = "";
        if (ps.length) {
          try {
            const st = L.fold(await L.yahoo(s, "/players;player_keys=" + ps.map(p => p.key).join(",") + "/stats;type=date;date=" + dates[i])).fantasy_content;
            if (q.get("raw") === "1" && !rawDay) rawDay = JSON.stringify(st).slice(0, 3000);
            const byKey = {};
            list(st.players).map(x => x.player || x).forEach(pl => {
              const stats = list(pl.player_stats && pl.player_stats.stats).map(x => x.stat || x);
              const gp = stats.find(x => String(x.stat_id) === "0");
              byKey[pl.player_key] = gp ? (Number(gp.value) || 0) : 0;
            });
            ps.forEach(p => { p.gp = byKey[p.key] || 0; });
          } catch (e) { dayErr = e.message; }
        }
        days.push({ date: dates[i], yahooDate: r.date || undefined, active: ps.filter(p => !BENCH[p.pos]).reduce((a, p) => a + p.gp, 0), bench: ps.filter(p => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0), players: ps, error: dayErr || undefined });
      }
      if (rawDay) warn.push("rawDay: " + rawDay);
      // a one-line picture of what Yahoo gave per day, so a flat week is easy to tell from a stuck one
      // each entry shows the date asked for and, in brackets, the date Yahoo says the roster is for
      warn.push("days: " + days.map(d => d.date.slice(5) + (d.yahooDate && d.yahooDate !== d.date ? "[" + d.yahooDate.slice(5) + "!]" : "") + ":" + (d.error ? "ERR" : ((d.players || []).filter(p => !BENCH[p.pos]).map(p => (p.name || "").split(" ").pop()).join("/") || "none"))).join(" | "));
      // the week's games played come from the days (the league context carries no GP stat)
      const gpByKey = {};
      days.forEach(d => (d.players || []).forEach(p => { gpByKey[p.key] = (gpByKey[p.key] || 0) + p.gp; }));
      players.forEach(p => { p.gp = gpByKey[p.key] || 0; });
      gamesOut.active = days.reduce((a, d) => a + (d.active || 0), 0);
      gamesOut.bench = days.reduce((a, d) => a + (d.bench || 0), 0);
      // keep the ledger current for this team: what this visit read is what everyone else sees
      // on its page until the next nightly run (service role only; a failure is just a warning)
      if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
          const supa = require("../_lib/supa"), ledger = require("../_lib/ledger");
          const map = await supa.one("team_map", "select=team_id&yahoo_team_key=eq." + encodeURIComponent(key));
          if (map && map.team_id) { const n = await ledger.writeLineups(map.team_id, days); warn.push("stored " + n + " lineup rows for " + map.team_id); }
          else warn.push("not stored: this Yahoo team isn't mapped to a site team yet (the nightly snapshot maps it)");
        } catch (e) { warn.push("store: " + e.message); }
      }
    }

    L.json(res, 200, {
      league: { id: L.LEAGUE_ID, name: league.name, week: week, currentWeek: curWeek, startWeek: startWeek, endWeek: endWeek, season: game.season, start: league.start_date, end: league.end_date, draft: league.draft_status || "", draftResults: draftDone },
      team: {
        key: key, id: team.team_id, name: team.name,
        logo: (list(team.team_logos).map(x => x.team_logo || x)[0] || {}).url || "",
        faab: team.faab_balance != null ? Number(team.faab_balance) : null, moves: Number(team.number_of_moves) || 0, trades: Number(team.number_of_trades) || 0,
        waiver: team.waiver_priority != null ? team.waiver_priority : null
      },
      standing: standing, matchup: matchup,
      lineup: { active: activeP.length, bench: benchP.length, il: ilP.length, injuredActive: activeP.filter(p => p.status).length },
      games: gamesOut,
      players: players,
      days: days,
      raw: q.get("raw") === "1" ? JSON.stringify((roster.roster && (roster.roster.players || (roster.roster["0"] && roster.roster["0"].players)) || [])[0] || roster).slice(0, 3000) : undefined,
      warn: warn,
      fetched: new Date().toISOString(),
      attribution: "Fantasy data provided by Yahoo Fantasy"
    });
  } catch (e) {
    if (e.code === 401) { L.clearCookie(res, L.COOKIE); return L.json(res, 401, { error: "not_connected" }); }
    L.json(res, 500, { error: e.message });
  }
};
