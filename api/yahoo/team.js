// The signed-in manager's own team in league 33689, this week, read live from Yahoo.
// Nothing is cached or stored; the response is marked no-store.
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
    const wantSeason = q.get("season") || "", wantWeek = Number(q.get("week")) || 0, wantDays = q.get("days") === "1";
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
    const league = L.fold((await L.yahoo(s, "/league/" + lk)).fantasy_content.league);
    const week = wantWeek || Number(league.current_week) || 1;

    // roster with this week's games played
    const roster = L.fold((await L.yahoo(s, "/team/" + key + "/roster;week=" + week + "/players/stats;type=week;week=" + week)).fantasy_content.team);
    const ro = roster.roster || {};
    const players = list(ro.players || (ro["0"] && ro["0"].players)).map(p => {
      const pl = p.player || p;
      const stats = list(pl.player_stats && pl.player_stats.stats).map(x => x.stat || x);
      const gp = stats.find(x => String(x.stat_id) === "0");
      const elig = list(pl.eligible_positions).map(x => (x && x.position) || x).filter(x => typeof x === "string");
      return {
        name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.selected_position && pl.selected_position.position,
        elig: elig, status: pl.status || "", note: pl.injury_note || pl.status_full || "",
        gp: gp ? Number(gp.value) || 0 : 0
      };
    });
    const activeP = players.filter(p => !BENCH[p.pos]), benchP = players.filter(p => p.pos === "BN"), ilP = players.filter(p => BENCH[p.pos] && p.pos !== "BN");
    const active = activeP.reduce((a, p) => a + p.gp, 0);

    // standings and this week's matchup are extras: a hiccup there must not hide the roster
    let standing = null, matchup = null, warn = [];
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
    let days = null;
    if (wantDays && matchup && matchup.start && matchup.end) {
      days = [];
      const d0 = new Date(matchup.start + "T12:00:00Z"), d1 = new Date(matchup.end + "T12:00:00Z");
      const dates = [];
      for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
      const got = await Promise.all(dates.map(date =>
        L.yahoo(s, "/team/" + key + "/roster;date=" + date + "/players/stats;type=date;date=" + date)
          .then(j => L.fold(j).fantasy_content.team).catch(e => ({ _err: e.message }))));
      got.forEach((t, i) => {
        if (t._err) { days.push({ date: dates[i], error: t._err }); return; }
        const r = t.roster || {};
        const ps = list(r.players || (r["0"] && r["0"].players)).map(p => {
          const pl = p.player || p;
          const stats = list(pl.player_stats && pl.player_stats.stats).map(x => x.stat || x);
          const gp = stats.find(x => String(x.stat_id) === "0");
          return { name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.selected_position && pl.selected_position.position, status: pl.status || "", gp: gp ? Number(gp.value) || 0 : 0 };
        });
        days.push({ date: dates[i], active: ps.filter(p => !BENCH[p.pos]).reduce((a, p) => a + p.gp, 0), bench: ps.filter(p => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0), players: ps });
      });
    }

    L.json(res, 200, {
      league: { id: L.LEAGUE_ID, name: league.name, week: week, season: game.season, start: league.start_date, end: league.end_date, draft: league.draft_status || "" },
      team: {
        key: key, id: team.team_id, name: team.name,
        logo: (list(team.team_logos).map(x => x.team_logo || x)[0] || {}).url || "",
        faab: team.faab_balance != null ? Number(team.faab_balance) : null, moves: Number(team.number_of_moves) || 0, trades: Number(team.number_of_trades) || 0,
        waiver: team.waiver_priority != null ? team.waiver_priority : null
      },
      standing: standing, matchup: matchup,
      lineup: { active: activeP.length, bench: benchP.length, il: ilP.length, injuredActive: activeP.filter(p => p.status).length },
      games: { active: active, cap: 30, bench: players.filter(p => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0) },
      players: players,
      days: days,
      warn: warn,
      fetched: new Date().toISOString(),
      attribution: "Fantasy data provided by Yahoo Fantasy"
    });
  } catch (e) {
    if (e.code === 401) { L.clearCookie(res, L.COOKIE); return L.json(res, 401, { error: "not_connected" }); }
    L.json(res, 500, { error: e.message });
  }
};
