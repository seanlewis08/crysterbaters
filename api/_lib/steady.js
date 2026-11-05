// Steadiness: how close to his average a player lands, game after game, scored 0–100.
//
// For each stat, every qualified player's game-to-game variance is set against the
// variance that is normal for a player with his average. "Normal" is fitted across the
// league: log(variance) = a + b·log(mean), least squares over the qualified players, so
// a 1.5-steal player is compared with other 1.5-steal players and a 25-point scorer with
// other 25-point scorers. The ratio (variance ÷ fitted variance) is 1 for a typical
// spread, below 1 for steadier, above 1 for boom-or-bust. Steadiness is that ratio's
// percentile turned round: 100 = the steadiest in the league for that stat, 50 = typical,
// 0 = the most up-and-down. Shared by the season table (api/ledger.js ?steady=) and the
// last-season builder (tools/steadiness.js).
"use strict";

const STATS = ["pts", "reb", "ast", "stl", "blk", "tpm", "tov", "min"];
const MIN_GP = 20;      // fewer games than this and the spread is mostly noise
const MIN_MPG = 10;     // garbage-time lines make anyone look erratic
const MIN_POOL = 30;    // a percentile among a handful of players means little

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function moments(games, k) {
  const n = games.length;
  let s = 0; games.forEach((g) => { s += g[k] || 0; });
  const m = s / n;
  let ss = 0; games.forEach((g) => { const d = (g[k] || 0) - m; ss += d * d; });
  return { m: m, v: n > 1 ? ss / (n - 1) : 0 };
}

// players: [{ id, name, team, games: [{ min, pts, reb, ast, stl, blk, tpm, tov }] }]
// (only games he played). Returns a compact table the browser joins by ESPN id.
function score(players, opts) {
  const o = opts || {};
  const minGp = o.minGp || MIN_GP, minMpg = o.minMpg == null ? MIN_MPG : o.minMpg;
  const pool = players.filter((p) => p.games && p.games.length >= minGp)
    .map((p) => {
      const mm = {}; STATS.forEach((k) => { mm[k] = moments(p.games, k); });
      return { p: p, mm: mm };
    })
    .filter((x) => x.mm.min.m >= minMpg);
  const fit = {}, n = {}, scoreOf = {};
  pool.forEach((x) => { scoreOf[x.p.id] = {}; });
  STATS.forEach((k) => {
    // the fit needs a spread to take a log of; a player who never varies still ranks (as the steadiest)
    const pts = pool.filter((x) => x.mm[k].m > 0 && x.mm[k].v > 0), ranked = pool.filter((x) => x.mm[k].m > 0);
    n[k] = ranked.length;
    if (pts.length < MIN_POOL) return;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach((x) => { const lx = Math.log(x.mm[k].m), ly = Math.log(x.mm[k].v); sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; });
    const F = pts.length, b = (F * sxy - sx * sy) / (F * sxx - sx * sx), a = (sy - b * sx) / F, N = ranked.length;
    fit[k] = [r2(a), r2(b)];
    const rs = ranked.map((x) => ({ id: x.p.id, r: x.mm[k].v / Math.exp(a + b * Math.log(x.mm[k].m)) }));
    const sorted = rs.map((x) => x.r).sort((p, q) => p - q);
    rs.forEach((x) => {
      // rank among the pool (ties share the middle), lowest ratio = steadiest = 100
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x.r) lo = mid + 1; else hi = mid; }
      let eq = lo; while (eq < sorted.length && sorted[eq] === x.r) eq++;
      const rank = (lo + eq - 1) / 2;
      scoreOf[x.id][k] = Math.round(100 * (1 - rank / Math.max(1, N - 1)));
    });
  });
  return {
    stats: STATS, minGp: minGp, minMpg: minMpg, n: n, fit: fit,
    // rows: [id, name, team, gp, [means…], [scores… or null]]
    rows: pool.map((x) => [x.p.id, x.p.name || "", x.p.team || "", x.p.games.length,
      STATS.map((k) => r1(x.mm[k].m)), STATS.map((k) => (scoreOf[x.p.id][k] == null ? null : scoreOf[x.p.id][k]))]),
  };
}

// This season, from our own box scores (every played line we hold).
async function season(supa) {
  const by = {};
  for (let off = 0; off < 200000; off += 1000) {
    const page = await supa.select("nba_box", "select=espn_id,name,nba,date,min,pts,reb,ast,stl,blk,tpm,tov&played=is.true&order=date.asc,espn_id.asc&limit=1000&offset=" + off);
    page.forEach((l) => {
      const p = by[l.espn_id] = by[l.espn_id] || { id: l.espn_id, name: l.name, team: l.nba, games: [] };
      p.team = l.nba || p.team;
      p.games.push(l);
    });
    if (page.length < 1000) break;
  }
  const out = score(Object.keys(by).map((k) => by[k]));
  const most = Object.keys(by).reduce((m, k) => Math.max(m, by[k].games.length), 0);
  return Object.assign({ built: new Date().toISOString(), scope: "season", mostGames: most }, out);
}

module.exports = { STATS, MIN_GP, score, season };
