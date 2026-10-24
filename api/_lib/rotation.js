// Rotation analysis from popcornmachine gameflow files.
//
// popcornmachine (github.com/seanlewis08/popcornmachine) publishes one
// gameflow.json per NBA game — every player's stints (period, in/out clock)
// plus the running score — on GitHub Pages. This module turns one of those
// files into the numbers a rotation conversation is made of, per team:
//   playersUsed, ninthMin (the 9th man's minutes), benchMin, starterShare,
//   maxMin / maxWho (heaviest load), byStarters (minutes with 0..5 starters on
//   the floor), minStarters (the fewest starters ever on the floor at once),
//   lowStarterMin (minutes with 0 or 1 starters), allFiveMin, starterStints,
//   lineups (distinct five-man units), units (top units with minutes and +/-),
//   segments (the starters-on-floor timeline), players (minutes, stints, role).
// sync() keeps Supabase's rotation_games / rotation_players in step with the
// published index, a few games per call. Nothing here reads anything but
// popcornmachine's own JSON, so when that site breaks this stays broken alone.
"use strict";

const supa = require("./supa");
const usage = require("./usage");

const BASE = () => (process.env.POPCORN_URL || "https://seanlewis08.github.io/popcornmachine/data").replace(/\/$/, "");

// seconds from tip-off for a clock reading inside a period (regulation 12:00, OT 5:00)
function secs(period, clock) {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(clock || "")); if (!m) return null;
  const plen = period <= 4 ? 720 : 300;
  const base = period <= 4 ? (period - 1) * 720 : 4 * 720 + (period - 5) * 300;
  return base + (plen - (Number(m[1]) * 60 + Number(m[2])));
}
const r1 = (x) => Math.round(x * 10) / 10;

// score differential for `tri` at `t` seconds, from the running score
function scoreAt(changes, t, isHome) {
  let h = 0, a = 0;
  for (let i = 0; i < changes.length; i++) { const c = changes[i]; if (c.ts * 60 > t + 1e-6) break; h = c.homeScore; a = c.awayScore; }
  return isHome ? h - a : a - h;
}

function teamMetrics(g, tri) {
  const isHome = g.homeTeam && g.homeTeam.tricode === tri;
  const changes = (g.scoreChanges || []).slice().sort((x, y) => x.ts - y.ts);
  const ps = (g.players || []).filter((p) => p.team === tri);
  const ev = [], mins = {}, nst = {}, name = {}, starters = new Set();
  ps.forEach((p) => {
    let tot = 0, n = 0;
    (p.stints || []).forEach((s) => {
      const a = secs(s.period, s.inTime), b = secs(s.period, s.outTime);
      if (a == null || b == null || b <= a) return;
      ev.push([a, 1, p.playerId]); ev.push([b, -1, p.playerId]); tot += b - a; n++;
    });
    mins[p.playerId] = tot / 60; nst[p.playerId] = n; name[p.playerId] = p.name;
    if (p.starter) starters.add(p.playerId);
  });
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // at the same instant, outs before ins
  const on = new Set(); let last = 0, lastDiff = scoreAt(changes, 0, isHome);
  const byStarters = {}, units = {}, segs = [];
  ev.forEach((e) => {
    const t = e[0];
    if (t > last && on.size) {
      const k = [...on].filter((id) => starters.has(id)).length, dur = t - last;
      byStarters[k] = (byStarters[k] || 0) + dur;
      const key = [...on].sort().join(","), diff = scoreAt(changes, t, isHome);
      const u = units[key] || (units[key] = { ids: [...on], sec: 0, pm: 0, n: 0 });
      u.sec += dur; u.pm += diff - lastDiff; u.n++; lastDiff = diff;
      const prev = segs[segs.length - 1];
      if (prev && prev[2] === k && Math.abs(prev[1] - last) < 1e-6) prev[1] = t; else segs.push([last, t, k]);
    }
    last = t;
    if (e[1] > 0) on.add(e[2]); else on.delete(e[2]);
  });
  const ids = Object.keys(mins).sort((x, y) => mins[y] - mins[x]);
  const used = ids.filter((id) => mins[id] > 0);
  const total = ids.reduce((s, id) => s + mins[id], 0);
  const startMin = ids.filter((id) => starters.has(id)).reduce((s, id) => s + mins[id], 0);
  const starterSec = (k) => byStarters[k] || 0;
  const unitList = Object.keys(units).map((k) => units[k]).sort((x, y) => y.sec - x.sec);
  return {
    playersUsed: used.length,
    ninthMin: r1(ids.length > 8 ? mins[ids[8]] : 0),
    benchMin: r1(ids.filter((id) => !starters.has(id)).reduce((s, id) => s + mins[id], 0)),
    starterShare: total ? Math.round(startMin / total * 1000) / 1000 : 0,
    maxMin: r1(ids.length ? mins[ids[0]] : 0), maxWho: ids.length ? name[ids[0]] : "",
    byStarters: [0, 1, 2, 3, 4, 5].map((k) => r1(starterSec(k) / 60)),
    minStarters: Math.min.apply(null, Object.keys(byStarters).map(Number).concat([5])),
    lowStarterMin: r1((starterSec(0) + starterSec(1)) / 60),
    allFiveMin: r1(starterSec(5) / 60),
    starterStints: ids.filter((id) => starters.has(id)).reduce((s, id) => s + nst[id], 0),
    // how long a starter stays out there per trip: starters' minutes over their stints
    starterStintMin: (function () { const n = ids.filter((id) => starters.has(id)).reduce((s, id) => s + nst[id], 0); return r1(n ? startMin / n : 0); })(),
    lineups: unitList.length,
    units: unitList.slice(0, 8).map((u) => ({ who: u.ids.slice().sort((x, y) => mins[y] - mins[x]).map((id) => name[id]), min: r1(u.sec / 60), pm: u.pm, stints: u.n, starters: u.ids.filter((id) => starters.has(id)).length })),
    segments: segs.map((s) => [r1(s[0] / 60), r1(s[1] / 60), s[2]]),
    players: ids.map((id, i) => ({ id: id, name: name[id], starter: starters.has(id), min: r1(mins[id]), stints: nst[id], rank: i + 1 })),
  };
}

// both teams of one gameflow file
function gameMetrics(g) {
  const home = g.homeTeam && g.homeTeam.tricode, away = g.awayTeam && g.awayTeam.tricode;
  if (!home || !away) throw new Error("gameflow without teams");
  const last = (g.scoreChanges || []).slice().sort((x, y) => x.ts - y.ts).pop() || { homeScore: 0, awayScore: 0 };
  const out = { gameId: g.gameId, home: home, away: away, homeScore: last.homeScore, awayScore: last.awayScore, teams: {} };
  out.teams[home] = teamMetrics(g, home); out.teams[away] = teamMetrics(g, away);
  return out;
}

async function getJson(url, ms) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("popcornmachine answered " + r.status + " for " + url.replace(BASE(), ""));
    return await r.json();
  } finally { clearTimeout(timer); }
}

// rows for Supabase from one game's metrics plus its index entry
function rows(m, entry) {
  const close = Math.abs(m.homeScore - m.awayScore) <= 10;
  const games = [], players = [];
  [m.home, m.away].forEach((tri) => {
    const t = m.teams[tri], isHome = tri === m.home, pts = isHome ? m.homeScore : m.awayScore, opp = isHome ? m.awayScore : m.homeScore;
    games.push({
      game_id: m.gameId, team: tri, opp: isHome ? m.away : m.home, home: isHome, date: entry.date, pts: pts, opp_pts: opp, close: close,
      players_used: t.playersUsed, ninth_min: t.ninthMin, bench_min: t.benchMin, starter_share: t.starterShare, max_min: t.maxMin, max_who: t.maxWho,
      min_starters: t.minStarters, low_starter_min: t.lowStarterMin, all_five_min: t.allFiveMin, starter_stints: t.starterStints, starter_stint_min: t.starterStintMin, lineups: t.lineups,
      by_starters: t.byStarters, detail: { units: t.units, segments: t.segments, players: t.players }, built_at: new Date().toISOString(),
    });
    t.players.forEach((p) => players.push({ game_id: m.gameId, date: entry.date, team: tri, opp: isHome ? m.away : m.home, player_id: p.id, name: p.name, starter: p.starter, minutes: p.min, stints: p.stints, rank: p.rank }));
  });
  return { games: games, players: players };
}

// Bring Supabase up to date with popcornmachine's index: new games only, a few
// per call (each gameflow is ~130 KB). Each game also fills usage_games /
// usage_players (api/_lib/usage.js) from the same file; a game missing from
// either set is pulled again. Returns what happened; never throws for one bad
// game, only when the index itself can't be read.
async function sync(opts) {
  const o = opts || {}, deadline = o.deadline || (Date.now() + 40000), limit = o.limit || 12;
  const out = { published: 0, stored: 0, added: [], skipped: [], notes: [] };
  const index = await getJson(BASE() + "/index.json");
  const entries = [];
  (index.dates || []).forEach((d) => (d.games || []).forEach((g) => entries.push({ gameId: String(g.gameId), date: d.date, home: g.home, away: g.away })));
  out.published = entries.length;
  // stored games; one computed before a column existed (starter_stint_min = 0) is pulled again
  let stored;
  try { stored = await supa.select("rotation_games", "select=game_id,starter_stint_min&limit=10000"); }
  catch (e) { stored = (await supa.select("rotation_games", "select=game_id&limit=10000")).map((r) => ({ game_id: r.game_id, starter_stint_min: 1 })); }
  const stale = new Set(stored.filter((r) => !(Number(r.starter_stint_min) > 0)).map((r) => r.game_id));
  // usage rows arrived later than rotation rows; a game stored without them is pulled again
  let usageHave = null;
  try { usageHave = new Set((await supa.select("usage_games", "select=game_id&limit=10000")).map((r) => r.game_id)); }
  catch (e) { out.notes.push("usage tables missing (run supabase/schema.sql): " + (e.message || e)); }
  const have = new Set(stored.map((r) => r.game_id).filter((g) => !stale.has(g) && (!usageHave || usageHave.has(g))));
  out.stored = have.size;
  // newest first: the page is opened for last night, and the older games follow on the next call
  const missing = entries.filter((e) => !have.has(e.gameId)).sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.gameId < b.gameId ? -1 : 1));
  out.missing = missing.length;
  for (const e of missing) {
    if (out.added.length >= limit) { out.notes.push("limit of " + limit + " games per call; " + (missing.length - out.added.length - out.skipped.length) + " left"); break; }
    if (Date.now() > deadline) { out.notes.push("time budget hit"); break; }
    try {
      const g = await getJson(BASE() + "/games/" + e.gameId + "/gameflow.json");
      const m = gameMetrics(g);
      if (!m.teams[e.home] || !m.teams[e.away]) throw new Error("teams in gameflow don't match the index");
      const rw = rows(m, e);
      await supa.upsert("rotation_games", rw.games, "game_id,team");
      await supa.upsert("rotation_players", rw.players, "game_id,player_id");
      if (usageHave) {
        const uw = usage.rows(g, e);
        await supa.upsert("usage_games", uw.games, "game_id,team");
        await supa.upsert("usage_players", uw.players, "game_id,player_id");
      }
      out.added.push(e.gameId);
    } catch (err) {
      out.skipped.push(e.gameId + ": " + (err.message || String(err)));
    }
  }
  return out;
}

module.exports = { secs, teamMetrics, gameMetrics, rows, sync, _base: BASE };
