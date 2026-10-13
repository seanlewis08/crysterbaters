// Yahoo's draft analysis (average pick, average round, % drafted) for the top of the
// player pool, read live for whoever is signed in; nothing stored.
const L = require("./_lib");
const list = v => Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
module.exports = async (req, res) => {
  try {
    const s = await L.session(req, res);
    if (!s) return L.json(res, 401, { error: "not_connected" });
    const q = new URL(req.url, L.origin(req)).searchParams;
    const pages = Math.min(Number(q.get("pages")) || 12, 20);   // 25 players a page
    const game = q.get("game") || "nba";
    let out = [], raw = null;
    for (let i = 0; i < pages; i++) {
      const j = await L.yahoo(s, "/game/" + game + "/players;start=" + (i * 25) + ";count=25;sort=AR/draft_analysis");
      if (q.get("raw") === "1" && !raw) raw = JSON.stringify(j).slice(0, 2500);
      const f = L.fold(j).fantasy_content.game;
      const ps = list(f.players || (f["0"] && f["0"].players) || (f[1] && f[1].players)).map(x => x.player || x);
      if (!ps.length) break;
      ps.forEach(pl => {
        const da = pl.draft_analysis || {};
        out.push({ name: pl.name && pl.name.full, team: pl.editorial_team_abbr, pos: pl.display_position, pick: Number(da.average_pick) || null, round: Number(da.average_round) || null, cost: Number(da.average_cost) || null, drafted: Number(da.percent_drafted) || null });
      });
      if (ps.length < 25) break;
    }
    L.json(res, 200, { players: out, fetched: new Date().toISOString(), raw: raw || undefined, attribution: "Fantasy data provided by Yahoo Fantasy" });
  } catch (e) {
    if (e.code === 401) { L.clearCookie(res, L.COOKIE); return L.json(res, 401, { error: "not_connected" }); }
    L.json(res, 500, { error: e.message });
  }
};
