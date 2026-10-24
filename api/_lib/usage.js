// Usage numbers from popcornmachine gameflow files.
//
// One gameflow (every player's stints with per-stint box stats and the
// play-by-play events inside them) becomes, per team, one usage_games row
// (possessions, minutes, per-period possessions, play types, shot zones) and,
// per player, one usage_players row: minutes, FGA/FTA/TOV/PTS/AST, makes,
// threes, assisted makes, the same split by period, play types from the NBA's
// own shot descriptors, distance zones and the fifteen NBA shot-chart zones.
// Rates (USG%, possession share, Offensive Load) are left to the page, which
// adds the rows up for whatever span of games it is showing.
"use strict";

const PT_KEYS = ["drive", "pullup", "spot", "finish", "cut", "post", "transition", "putback"];
const ZONE_KEYS = ["rim", "paint", "mid", "three"];

const r1 = (x) => Math.round(x * 10) / 10;

// play type from the descriptor words the NBA writes into each shot (and the fastbreak qualifier)
function classify(desc, sh) {
  const d = String((sh && sh.descriptor) || "").toLowerCase(), text = String(desc || "").toLowerCase();
  const quals = ((sh && sh.qualifiers) || []).map((q) => String(q).toLowerCase());
  if (quals.indexOf("fastbreak") >= 0) return "transition";
  if (d.indexOf("putback") >= 0 || d.indexOf("tip") >= 0 || /\btip\b/.test(text)) return "putback";
  if (d.indexOf("driving") >= 0) return "drive";
  if (d.indexOf("pullup") >= 0 || d.indexOf("pull-up") >= 0 || d.indexOf("step back") >= 0 || d.indexOf("stepback") >= 0) return "pullup";
  if (d.indexOf("cutting") >= 0 || d.indexOf("alley") >= 0 || text.indexOf("alley") >= 0) return "cut";
  if (d.indexOf("hook") >= 0 || d.indexOf("turnaround") >= 0 || d.indexOf("fadeaway") >= 0 || d.indexOf("post") >= 0 || text.indexOf("hook") >= 0) return "post";
  if (d.indexOf("running") >= 0) return "transition";
  if (/layup|dunk/.test(text)) return "finish";
  return "spot";
}

// distance band the way NBA Hotspots bins it: 0-8, 8-16, 16+ (twos), three
function zoneOf(desc, sh, three) {
  if (three) return "three";
  let dist = sh && sh.dist != null ? Number(sh.dist) : null;
  if (dist == null || isNaN(dist)) {
    const m = /(\d+)'/.exec(desc || "");
    dist = m ? Number(m[1]) : (/layup|dunk|tip/i.test(desc || "") ? 0 : null);
  }
  if (dist == null) return null;
  return dist < 8 ? "rim" : (dist < 16 ? "paint" : "mid");
}

// the fifteen NBA shot-chart zones: popcornmachine's `area` (the NBA's six) is the source of
// truth; x/y (tenths of a foot from the basket) only split mid-range and above-the-break into wedges
function zone14(sh, three) {
  if (!sh || sh.x == null || sh.y == null) return null;
  const x = Number(sh.x), y = Number(sh.y);
  if (isNaN(x) || isNaN(y)) return null;
  const r = Math.hypot(x, y) / 10, th = Math.atan2(x, y) * 180 / Math.PI, area = sh.area || "";
  if (area === "Left Corner 3") return "c3l";
  if (area === "Right Corner 3") return "c3r";
  if (area === "Above the Break 3" || area === "Backcourt" || (!area && three)) {
    if (!area && y < 89.4 && Math.abs(x) >= 215) return x < 0 ? "c3l" : "c3r";
    return th < -30 ? "a3l" : (th > 30 ? "a3r" : "a3c");
  }
  if (area === "Restricted Area" || (!area && r < 5)) return "ra";
  if (area === "In The Paint (Non-RA)" || (!area && Math.abs(x) <= 80 && y <= 137.5)) return "paint";
  if (r < 16) return th < -45 ? "m8l" : (th > 45 ? "m8r" : "m8c");
  return th < -60 ? "m16l" : (th < -20 ? "m16lc" : (th <= 20 ? "m16c" : (th <= 60 ? "m16rc" : "m16r")));
}

const AST_RE = /\(([A-Z]\. ?[^()]+?) \d+ AST\)/;
function shortName(name) { const p = String(name || "").split(" "); return p.length > 1 ? (p[0][0] + ". " + p.slice(1).join(" ")).toLowerCase() : String(name || "").toLowerCase(); }

function newPlayer() {
  return { min: 0, fga: 0, fta: 0, tov: 0, pts: 0, ast: 0, astDesc: 0, fgm: 0, fg3a: 0, fg3m: 0, astFg: 0,
    q: [0, 1, 2, 3, 4].map(() => ({ min: 0, pos: 0, fga: 0 })), pt: {}, zone: {}, z14: {} };
}
function bump(o, k, made) { const v = o[k] || (o[k] = [0, 0]); v[0]++; if (made) v[1]++; }

// one team's usage from one gameflow file
function teamUsage(g, tri) {
  const ps = (g.players || []).filter((p) => p.team === tri);
  const shorts = {}; ps.forEach((p) => { shorts[shortName(p.name)] = p.playerId; });
  const P = {}, T = { min: 0, pos: 0, fga: 0, fta: 0, tov: 0, q: [0, 1, 2, 3, 4].map(() => ({ min: 0, pos: 0 })), pt: {}, zone: {} };
  const periods = new Set();
  ps.forEach((p) => {
    const a = P[p.playerId] = newPlayer(); a.name = p.name; a.starter = !!p.starter;
    (p.stints || []).forEach((st) => {
      const period = Number(st.period) || 1, qi = Math.min(period, 5) - 1; periods.add(period);
      const mins = Number(st.minutes) || 0, s = st.stats || {};
      const fga = Number(s.fga) || 0, fta = Number(s.fta) || 0, tov = Number(s.tov) || 0, pos = fga + 0.44 * fta + tov;
      a.min += mins; a.q[qi].min += mins; a.q[qi].fga += fga; a.q[qi].pos += pos; T.q[qi].pos += pos;
      a.fga += fga; a.fta += fta; a.tov += tov; a.pts += Number(s.pts) || 0; a.ast += Number(s.ast) || 0;
      a.fgm += Number(s.fgm) || 0; a.fg3a += Number(s.fg3a) || 0; a.fg3m += Number(s.fg3m) || 0;
      T.min += mins; T.pos += pos; T.fga += fga; T.fta += fta; T.tov += tov;
      (st.events || []).forEach((e) => {
        const t = String(e.type || "");
        if (t !== "Make2" && t !== "Make3" && t !== "miss2" && t !== "miss3") return;
        const sh = e.shot || null, desc = e.description || "", made = t.indexOf("Make") === 0, three = /3$/.test(t);
        const pt = classify(desc, sh), z = zoneOf(desc, sh, three), z14 = zone14(sh, three);
        bump(a.pt, pt, made); T.pt[pt] = (T.pt[pt] || 0) + 1;
        if (z) { bump(a.zone, z, made); T.zone[z] = (T.zone[z] || 0) + 1; }
        if (z14) bump(a.z14, z14, made);
        if (made) {
          const assisted = sh && typeof sh.assisted === "boolean" ? sh.assisted : AST_RE.test(desc);
          if (assisted) a.astFg++;
          const m = AST_RE.exec(desc);
          if (m) { const who = shorts[m[1].trim().toLowerCase()]; if (who && P[who]) P[who].astDesc++; else if (who) (P[who] = newPlayer()).astDesc++; }
        }
      });
    });
  });
  periods.forEach((per) => { T.q[Math.min(per, 5) - 1].min += 5 * (per <= 4 ? 12 : 5); });
  // stint stats carry assists in newer files; older ones only name the passer in the description
  const useDesc = Object.keys(P).reduce((s, id) => s + P[id].ast, 0) === 0;
  const players = Object.keys(P).filter((id) => P[id].name && P[id].min > 0).map((id) => {
    const a = P[id];
    return { id: id, name: a.name, starter: a.starter, min: r1(a.min), fga: a.fga, fta: a.fta, tov: a.tov, pts: a.pts, ast: useDesc ? a.astDesc : a.ast,
      fgm: a.fgm, fg3a: a.fg3a, fg3m: a.fg3m, ast_fg: a.astFg, q: a.q.map((x) => ({ min: r1(x.min), pos: r1(x.pos), fga: x.fga })), pt: a.pt, zone: a.zone, z14: Object.keys(a.z14).length ? a.z14 : null };
  }).sort((x, y) => y.min - x.min);
  return { min: r1(T.min), pos: r1(T.pos), fga: T.fga, fta: T.fta, tov: T.tov, q: T.q.map((x) => ({ min: x.min, pos: r1(x.pos) })), pt: T.pt, zone: T.zone, players: players };
}

// rows for Supabase: usage_games (one per team) and usage_players (one per player)
function rows(g, entry) {
  const home = g.homeTeam && g.homeTeam.tricode, away = g.awayTeam && g.awayTeam.tricode;
  if (!home || !away) throw new Error("gameflow without teams");
  const games = [], players = [], built = new Date().toISOString();
  [home, away].forEach((tri) => {
    const t = teamUsage(g, tri), isHome = tri === home, opp = isHome ? away : home;
    games.push({ game_id: String(g.gameId), team: tri, opp: opp, home: isHome, date: entry.date, min: t.min, poss: t.pos, fga: t.fga, fta: t.fta, tov: t.tov, q: t.q, pt: t.pt, zone: t.zone, built_at: built });
    t.players.forEach((p) => players.push({ game_id: String(g.gameId), date: entry.date, team: tri, opp: opp, player_id: p.id, name: p.name, starter: p.starter, min: p.min,
      fga: p.fga, fta: p.fta, tov: p.tov, pts: p.pts, ast: p.ast, fgm: p.fgm, fg3a: p.fg3a, fg3m: p.fg3m, ast_fg: p.ast_fg, q: p.q, pt: p.pt, zone: p.zone, z14: p.z14 }));
  });
  return { games: games, players: players };
}

module.exports = { classify, zoneOf, zone14, teamUsage, rows, PT_KEYS, ZONE_KEYS };
