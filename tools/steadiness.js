#!/usr/bin/env node
// Build steady.json: Steadiness scores (0–100) for a finished season from ESPN game logs.
//
//   node tools/steadiness.js          # 2025-26 (season 2026), every players.json player with 20+ games
//   node tools/steadiness.js 2026
//
// One ESPN game-log read per player (about 450, eight at a time, a minute or two). The
// current season is scored live by /api/ledger?steady=season from our own box scores;
// this file is for a season that is over. See api/_lib/steady.js for the method.
"use strict";
const fs = require("fs"), path = require("path");
const steady = require("../api/_lib/steady");

const season = Number(process.argv[2]) || 2026;
const ROOT = path.join(__dirname, "..");
const GAMELOG = (id) => "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/" + id + "/gamelog?season=" + season;

async function get(url, tries) {
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (crysterbaters league site)" } });
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  return null;
}

// a game log row → our line; regular season only (not the play-in, preseason or playoffs)
function lines(d) {
  if (!d || !d.names || !d.seasonTypes) return [];
  const ix = {}; d.names.forEach((n, i) => { ix[n] = i; });
  const st = d.seasonTypes.find((s) => /Regular Season$/.test(s.displayName || "") && !/Play ?In/i.test(s.displayName || ""));
  if (!st) return [];
  const num = (s) => { const n = parseFloat(String(s == null ? "" : s).split("-")[0]); return isNaN(n) ? 0 : n; };
  const seen = {}, out = [];
  (st.categories || []).forEach((c) => (c.events || []).forEach((e) => {
    if (seen[e.eventId]) return; seen[e.eventId] = 1;
    const s = e.stats || [];
    const g = { min: num(s[ix.minutes]), pts: num(s[ix.points]), reb: num(s[ix.totalRebounds]), ast: num(s[ix.assists]),
      stl: num(s[ix.steals]), blk: num(s[ix.blocks]), tov: num(s[ix.turnovers]), tpm: num(s[ix["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]]) };
    if (g.min > 0) out.push(g);
  }));
  return out;
}

(async () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, "players.json"), "utf8"));
  const C = {}; pj.cols.forEach((k, i) => { C[k] = i; });
  const want = pj.players.filter((r) => r[C.id] > 0 && (pj.statsSeason !== season || r[C.gp] >= steady.MIN_GP))
    .map((r) => ({ id: r[C.id], name: r[C.name], team: r[C.team] }));
  console.log("season " + (season - 1) + "-" + String(season).slice(2) + ": reading " + want.length + " game logs");
  const players = []; let i = 0, done = 0;
  async function worker() {
    while (i < want.length) {
      const p = want[i++];
      const g = lines(await get(GAMELOG(p.id)));
      if (g.length) players.push(Object.assign({ games: g }, p));
      if (++done % 50 === 0) console.log("  " + done + " / " + want.length);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const out = steady.score(players);
  const file = path.join(ROOT, "steady.json");
  let all = { seasons: {} };
  try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* new file */ }
  all.built = new Date().toISOString();
  all.seasons = all.seasons || {};
  all.seasons[season] = Object.assign({ built: all.built, scope: "season", source: "ESPN game logs" }, out);
  fs.writeFileSync(file, JSON.stringify(all));
  console.log("scored " + out.rows.length + " players (20+ games, 10+ min) · pool per stat " + JSON.stringify(out.n));
  console.log("wrote " + file + " " + fs.statSync(file).size + " bytes");
})();
