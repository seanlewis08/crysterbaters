// The signed-in manager's own team in league 33689, this week, read live from Yahoo.
// Nothing is cached or stored; the response is marked no-store.
const L = require("./_lib");
const BENCH = { BN: 1, IL: 1, "IL+": 1, IR: 1, NA: 1 };
module.exports = async (req, res) => {
  try {
    const s = await L.session(req, res);
    if (!s) return L.json(res, 401, { error: "not_connected", why: res.cbWhy || "", v: 2 });
    // every NBA team this login owns, newest season first
    const games = L.fold((await L.yahoo(s, "/users;use_login=1/games;game_codes=nba/teams")).fantasy_content.users)[0].user.games;
    let team = null, game = null;
    (games || []).slice().reverse().some(g => {
      const gg = g.game; const teams = gg.teams || [];
      const t = teams.map(x => x.team).find(x => (x.team_key || "").indexOf(".l." + L.LEAGUE_ID + ".") > 0);
      if (t) { team = t; game = gg; return true; } return false;
    });
    if (!team) {
      // say what Yahoo did return (this login's own seasons and team keys) so a renewed league's new ID is easy to spot
      const seen = (games || []).map(g => {
        const gg = (g && g.game) || {};
        const ts = (Array.isArray(gg.teams) ? gg.teams : []).map(x => x && x.team ? (x.team.team_key + " " + (x.team.name || "")) : JSON.stringify(x).slice(0, 80));
        return (gg.season || "?") + ": " + (ts.join(", ") || "no teams");
      });
      const last = (games || [])[(games || []).length - 1];
      return L.json(res, 404, { error: "no_team", detail: "This Yahoo account has no team in league " + L.LEAGUE_ID + ". Yahoo returned — " + (seen.join(" | ") || "no NBA seasons"), raw: JSON.stringify(last || null).slice(0, 2500) });
    }
    const lk = team.team_key.replace(/\.t\.\d+$/, "");
    const league = L.fold((await L.yahoo(s, "/league/" + lk)).fantasy_content.league);
    const week = league.current_week || 1;
    const roster = L.fold((await L.yahoo(s, "/team/" + team.team_key + "/roster;week=" + week + "/players/stats;type=week;week=" + week)).fantasy_content.team);
    const ro = roster.roster || {};
    const players = (ro.players || (ro["0"] && ro["0"].players) || []).map(p => {
      const pl = p.player;
      const stats = (pl.player_stats && pl.player_stats.stats || []).map(x => x.stat);
      const gp = stats.find(x => String(x.stat_id) === "0");
      return {
        name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.selected_position && pl.selected_position.position,
        status: pl.status || "", gp: gp ? Number(gp.value) || 0 : 0
      };
    });
    const active = players.filter(p => !BENCH[p.pos]).reduce((a, p) => a + p.gp, 0);
    L.json(res, 200, {
      league: { id: L.LEAGUE_ID, name: league.name, week: week, season: game.season, start: league.start_date, end: league.end_date },
      team: { key: team.team_key, name: team.name, logo: team.team_logos && team.team_logos[0] && team.team_logos[0].team_logo && team.team_logos[0].team_logo.url },
      games: { active: active, cap: 30, bench: players.filter(p => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0) },
      players: players,
      fetched: new Date().toISOString(),
      attribution: "Fantasy data provided by Yahoo Fantasy"
    });
  } catch (e) {
    if (e.code === 401) { L.clearCookie(res, L.COOKIE); return L.json(res, 401, { error: "not_connected" }); }
    L.json(res, 500, { error: e.message });
  }
};
