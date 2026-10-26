// The live scoreboard: every matchup of the week, scored by the site itself.
//
// Week totals are the sum of each team's active-slot players' box-score lines,
// day by day: the slots come from lineup_days (Yahoo, re-read for today while
// people are watching), the lines from nba_box (ESPN, stored nightly) plus, for
// today, ESPN's live box scores read here. Yahoo's own scoreboard is kept only
// as a check (matchups table) — it says who plays whom and what Yahoo thinks the
// score is. Everything is read-only.
//
//   week()          one payload for the whole page: lineups, lines, games, projections
//   refreshToday()  re-read today's lineups for all ten teams from Yahoo (the button)
//   game(id)        one ESPN game: box scores, stints from the substitution log,
//                   the score margin from the scoring plays
//   projections()   refresh player_proj from ESPN's fantasy projections (nightly)
"use strict";

const supa = require("./supa");
const ledger = require("./ledger");
const yahoo = require("./yahoo-server");

const ESPN = process.env.ESPN_URL || "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const BENCH = ledger.BENCH;
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const now = () => new Date().toISOString();

async function espn(path, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 9000);
  try {
    const r = await fetch(ESPN + path, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error("ESPN " + r.status + " on " + path);
    return await r.json();
  } finally { clearTimeout(t); }
}
const num = (s) => { const n = parseInt(String(s == null ? "" : s).split("-")[0], 10); return isNaN(n) ? 0 : n; };
const pair = (s) => { const m = /^(\d+)-(\d+)$/.exec(String(s || "")); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };

// ---- small warm-instance caches (a function instance serves many calls) ----
const cache = {};
function memo(key, ttlMs, fn) {
  const c = cache[key];
  if (c && Date.now() < c.exp) return c.p;
  const p = fn().catch((e) => { delete cache[key]; throw e; });
  cache[key] = { p: p, exp: Date.now() + ttlMs };
  return p;
}

// ---- today's games and live box scores ------------------------------------
// elapsed game minutes for a period + clock ("7:36" left in the period)
function elapsed(period, clock) {
  const c = String(clock || "").trim(); const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(c);
  const left = m ? Number(m[1]) + Number(m[2]) / 60 : (/^\d+(?:\.\d+)?$/.test(c) ? Number(c) / 60 : 0); // "7:36", or "55.6" seconds under a minute
  const p = Number(period) || 1;
  const before = p <= 4 ? (p - 1) * 12 : 48 + (p - 5) * 5;
  const len = p <= 4 ? 12 : 5;
  return before + (len - Math.min(left, len));
}
function gameFromEvent(ev) {
  const comp = (ev.competitions || [])[0] || {}, st = (ev.status && ev.status.type) || {};
  const away = (comp.competitors || []).find((c) => c.homeAway === "away") || {}, home = (comp.competitors || []).find((c) => c.homeAway === "home") || {};
  return {
    id: String(ev.id), date: ledger.etDate(new Date(ev.date)), start: ev.date,
    away: ledger.abbr(away.team && away.team.abbreviation), home: ledger.abbr(home.team && home.team.abbreviation),
    awayId: String(away.team && away.team.id || ""), homeId: String(home.team && home.team.id || ""),
    awayScore: Number(away.score) || 0, homeScore: Number(home.score) || 0,
    state: st.state || "pre", detail: st.shortDetail || st.detail || "", period: Number(ev.status && ev.status.period) || 0, clock: (ev.status && ev.status.displayClock) || "",
    elapsed: st.state === "pre" ? 0 : st.state === "post" ? Math.max(48, elapsed(ev.status && ev.status.period, "0:00")) : elapsed(ev.status && ev.status.period, ev.status && ev.status.displayClock),
  };
}
async function scoreboard(date) {
  return memo("sb:" + date, 45 * 1000, async () => {
    const sb = await espn("/scoreboard?dates=" + date.replace(/-/g, "") + "&limit=1000");
    return (sb.events || []).filter((ev) => !(ev.season && ev.season.type === 1)).map(gameFromEvent).filter((g) => g.date === date);
  });
}
// one game's summary → box lines (both teams), stints, margin track
function parseSummary(sum, g) {
  const sides = (sum.boxscore && sum.boxscore.players) || [];
  const teamTri = {}; teamTri[g.awayId] = g.away; teamTri[g.homeId] = g.home;
  const lines = {}, byTeam = {}; byTeam[g.away] = []; byTeam[g.home] = [];
  sides.forEach((side) => {
    const tri = ledger.abbr(side.team && side.team.abbreviation);
    const stat = (side.statistics || [])[0] || {}; const labels = stat.labels || stat.names || [];
    const ix = {}; labels.forEach((l, i) => { ix[l] = i; });
    (stat.athletes || []).forEach((a) => {
      const id = Number(a.athlete && a.athlete.id); if (!id) return;
      const s = a.stats || []; const gx = (l) => (ix[l] == null ? "" : s[ix[l]]);
      const fg = pair(gx("FG")), tp = pair(gx("3PT")), ft = pair(gx("FT"));
      const played = !a.didNotPlay && s.length > 0 && (num(gx("MIN")) > 0 || num(gx("PTS")) > 0 || fg[1] > 0 || num(gx("REB")) > 0);
      const row = { espn: id, name: (a.athlete.displayName || ""), pos: (a.athlete.position && a.athlete.position.abbreviation) || "", nba: tri, starter: !!a.starter, dnp: !!a.didNotPlay, reason: a.reason || "", played: played,
        min: num(gx("MIN")), pts: num(gx("PTS")), reb: num(gx("REB")), ast: num(gx("AST")), stl: num(gx("STL")), blk: num(gx("BLK")), tpm: tp[0], fgm: fg[0], fga: fg[1], ftm: ft[0], fta: ft[1], tov: num(gx("TO")), pf: num(gx("PF")), on: false };
      lines[id] = row; (byTeam[tri] = byTeam[tri] || []).push(row);
    });
  });
  // stints from the substitution log; the five starters open the game
  const plays = (sum.plays || []).slice().sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  const on = {}; on[g.away] = new Set(); on[g.home] = new Set();
  const stints = {}; const open = {};
  Object.keys(byTeam).forEach((tri) => { byTeam[tri].forEach((r) => { if (r.starter) { on[tri].add(r.espn); open[r.espn] = 0; } }); });
  const track = [[0, 0]];
  plays.forEach((p) => {
    const t = elapsed(p.period && p.period.number, p.clock && p.clock.displayValue);
    if (p.scoringPlay) track.push([t, (Number(p.homeScore) || 0) - (Number(p.awayScore) || 0)]);
    if (p.type && /substitution/i.test(p.type.text || "")) {
      const tri = teamTri[String(p.team && p.team.id)]; if (!tri) return;
      const ids = (p.participants || []).map((x) => Number(x.athlete && x.athlete.id)).filter(Boolean);
      const inId = ids[0], outId = ids[1];
      if (outId && open[outId] != null) { (stints[outId] = stints[outId] || []).push([open[outId], t]); delete open[outId]; on[tri].delete(outId); }
      if (inId) { open[inId] = t; on[tri].add(inId); }
    }
  });
  const end = g.state === "post" ? Math.max(48, g.elapsed) : g.elapsed;
  Object.keys(open).forEach((id) => { (stints[id] = stints[id] || []).push([open[id], end]); if (g.state === "in" && lines[id]) lines[id].on = true; });
  if (track.length === 1 || track[track.length - 1][0] < end) track.push([end, g.homeScore - g.awayScore]);
  const round1 = (x) => Math.round(x * 10) / 10;
  Object.keys(stints).forEach((id) => { stints[id] = stints[id].map((s) => [round1(s[0]), round1(s[1])]).filter((s) => s[1] > s[0]); });
  return { lines: lines, byTeam: byTeam, stints: stints, track: track.map((p) => [round1(p[0]), p[1]]) };
}
async function summary(g) {
  const ttl = g.state === "post" ? 10 * 60 * 1000 : 45 * 1000;
  return memo("sum:" + g.id, ttl, async () => parseSummary(await espn("/summary?event=" + g.id), g));
}

// ---- matchups: who plays whom, and Yahoo's own score, for the check ----------
async function yahooScoreboard(week) {
  const sb = await yahoo.scoreboard(week);
  return sb;
}
async function matchupsFor(meta, week, force) {
  const season = String(meta.season || "");
  const stored = await supa.select("matchups", "select=a,b,yahoo,yahoo_at&season=eq." + season + "&week=eq." + week).catch(() => []);
  const fresh = stored.length && stored.every((r) => r.yahoo_at && Date.now() - new Date(r.yahoo_at).getTime() < 6 * 3600 * 1000);
  if (fresh && !force) return { rows: stored, note: "" };
  try {
    const sb = await yahooScoreboard(week);
    const map = await supa.select("team_map", "select=team_id,yahoo_team_key");
    const idOf = {}; map.forEach((m) => { idOf[m.yahoo_team_key] = m.team_id; });
    const rows = sb.matchups.map((m) => {
      const a = idOf[m.teams[0].key], b = idOf[m.teams[1] && m.teams[1].key];
      if (!a || !b) return null;
      const y = { a: m.teams[0].stats, b: m.teams[1].stats, akey: m.teams[0].key, bkey: m.teams[1].key, winners: m.winners, status: m.status };
      return { season: season, week: week, a: a, b: b, yahoo: y, yahoo_at: now() };
    }).filter(Boolean);
    if (rows.length) await supa.upsert("matchups", rows, "season,week,a").catch(() => {});
    return { rows: rows.length ? rows : stored, note: rows.length ? "" : "Yahoo answered without matchups" };
  } catch (e) {
    return { rows: stored, note: "Yahoo check unavailable: " + (e.message || e) };
  }
}

// ---- today's lineups from Yahoo (the refresh) --------------------------------
let lastRefresh = 0;
// every team's lineup for each of `dates`, as Yahoo holds it now (one Yahoo
// call per date for the whole league). Today is what people watch; the rest of
// the week matters too, because managers set their later days whenever they like
// and the nightly run only sees what was set by the morning.
async function refreshDays(dates) {
  const map = await yahoo.mappedTeams();
  const idByKey = {}; map.forEach((m) => { if (m.team_id) idByKey[m.key] = m.team_id; });
  let n = 0;
  for (const date of dates) {
    const teams = await yahoo.leagueRostersOn(date);
    for (const t of teams) {
      const id = idByKey[t.key]; if (!id) continue;
      await ledger.writeLineups(id, [{ date: date, players: t.players.map((p) => ({ key: p.key, name: p.name, team: p.nba, pos: p.pos, status: p.status })) }]);
      n++;
    }
  }
  return n;
}
async function refreshToday(force, moreDates) {
  const today = ledger.etDate();
  if (!force && Date.now() - lastRefresh < 60 * 1000) return { at: new Date(lastRefresh).toISOString(), skipped: true };
  const n = await refreshDays([today].concat(moreDates || []));
  lastRefresh = Date.now();
  return { at: now(), teams: n, days: 1 + (moreDates || []).length };
}

// ---- the week payload --------------------------------------------------------
async function week(opts) {
  const o = opts || {};
  const meta = await supa.one("league_meta", "select=*&id=eq.current");
  if (!meta) throw new Error("no_snapshot");
  const wd = ledger.weekDates(meta);
  const cur = Number(meta.current_week) || 1;
  const wk = Math.min(Math.max(Number(o.week) || cur, Number(meta.start_week) || 1), Number(meta.end_week) || cur);
  const range = wd[wk]; if (!range) throw new Error("no week dates");
  const today = ledger.etDate();
  const dates = ledger.daysBetween(range[0], range[1]);
  const notes = [];

  // lineups for the week; today's re-read from Yahoo when stale (people are watching)
  let lines = await supa.select("lineup_days", "select=team_id,date,yahoo_key,player,nba,pos,status,espn_id,updated_at&date=gte." + range[0] + "&date=lte." + range[1] + "&order=date.asc&limit=5000");
  const newestOn = (d) => lines.filter((l) => l.date === d).reduce((m, l) => (l.updated_at > m ? l.updated_at : m), "");
  const newest = newestOn(today);
  const staleMs = o.live ? 5 * 60 * 1000 : 30 * 60 * 1000;
  // the rest of the week is re-read when it is more than two hours old (or never stored), with today
  const later = dates.filter((d) => d > today && (!newestOn(d) || Date.now() - new Date(newestOn(d)).getTime() > 2 * 3600 * 1000));
  const todayStale = !newest || Date.now() - new Date(newest).getTime() > staleMs;
  if (today >= range[0] && today <= range[1] && (todayStale || later.length)) {
    try {
      if (todayStale) await refreshToday(false, later); else await refreshDays(later);
      lines = await supa.select("lineup_days", "select=team_id,date,yahoo_key,player,nba,pos,status,espn_id,updated_at&date=gte." + range[0] + "&date=lte." + range[1] + "&order=date.asc&limit=5000");
    }
    catch (e) { notes.push("Lineups are as last stored (Yahoo: " + (e.message || e) + ")"); }
  }
  // a past day of this week whose box scores never landed (the nightly run was
  // refused or ran out of time) is fetched now, within a small budget, so the
  // score is never short a day for long. Once per instance per ten minutes.
  const past = dates.filter((d) => d < today);
  if (past.length) {
    try {
      const doneRows = await supa.select("nba_days", "select=date,done&date=in.(" + past.join(",") + ")");
      const done = {}; doneRows.forEach((r) => { if (r.done) done[r.date] = 1; });
      const missing = past.filter((d) => !done[d]);
      if (missing.length) {
        const deadline = Date.now() + 25 * 1000;
        for (const d of missing) {
          if (Date.now() > deadline) { notes.push("Box scores for " + d + " still filling in"); break; }
          const r = await memo("fill:" + d, 10 * 60 * 1000, () => ledger.fetchBox(d, deadline));
          if (r && !r.done) notes.push("Box scores for " + d + ": " + r.finals + " of " + r.games + " games stored");
        }
      }
    } catch (e) { notes.push("Box-score backfill: " + (e.message || e)); }
  }

  // a lineup row stored before its player had an ESPN id (a rookie before his
  // first game, a name Yahoo spells differently) is linked now, for every day it
  // was stored, so his lines count; nothing to do when everyone is linked
  let unmatched = [];
  const unlinked = lines.filter((l) => !l.espn_id && l.yahoo_key);
  if (unlinked.length) {
    try {
      const links = await ledger.linkPlayers(unlinked);
      const fixed = Object.keys(links).filter((k) => links[k]);
      for (const k of fixed) {
        await supa.update("lineup_days", "yahoo_key=eq." + encodeURIComponent(k) + "&espn_id=is.null", { espn_id: links[k] }).catch(() => {});
        lines.forEach((l) => { if (l.yahoo_key === k && !l.espn_id) l.espn_id = links[k]; });
      }
      unmatched = Array.from(new Set(unlinked.filter((l) => !l.espn_id).map((l) => l.player)));
    } catch (e) { notes.push("Player linking: " + (e.message || e)); }
  }
  const lineupAt = lines.filter((l) => l.date === today).reduce((m, l) => (l.updated_at > m ? l.updated_at : m), "") || newest;
  const status = ledger.freshestStatus(lines);
  const lineups = {}; lines.forEach((l) => { const t = lineups[l.team_id] = lineups[l.team_id] || {}; (t[l.date] = t[l.date] || []).push({ key: l.yahoo_key, name: l.player, nba: l.nba, pos: l.pos, status: status[l.yahoo_key] != null ? status[l.yahoo_key] : l.status, espn: l.espn_id || null }); });
  const ids = Array.from(new Set(lines.map((l) => l.espn_id).filter(Boolean)));

  // stored lines (finals) for the week
  const box = {};
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 300) {
      const rows = await supa.select("nba_box", "select=espn_id,date,played,min,pts,reb,ast,stl,blk,tpm,fgm,fga,ftm,fta,tov&date=gte." + range[0] + "&date=lte." + range[1] + "&espn_id=in.(" + ids.slice(i, i + 300).join(",") + ")");
      rows.forEach((b) => { box[b.espn_id + "|" + b.date] = b; });
    }
  }

  // today's games, live lines, who is on the floor
  let games = [], live = {}, liveAt = null;
  if (today >= range[0] && today <= range[1]) {
    try {
      games = await scoreboard(today);
      const going = games.filter((g) => g.state !== "pre");
      const sums = await Promise.all(going.map((g) => summary(g).catch(() => null)));
      sums.forEach((s, i) => { if (!s) return; const g = going[i]; Object.keys(s.lines).forEach((id) => { const r = s.lines[id]; live[id] = { game: g.id, nba: r.nba, played: r.played, dnp: r.dnp, on: r.on, min: r.min, pts: r.pts, reb: r.reb, ast: r.ast, stl: r.stl, blk: r.blk, tpm: r.tpm, fgm: r.fgm, fga: r.fga, ftm: r.ftm, fta: r.fta, tov: r.tov, pf: r.pf }; }); });
      liveAt = now();
    } catch (e) { notes.push("ESPN live: " + (e.message || e)); }
  }

  // the rest of the week's schedule, for projections (who plays again)
  const schedule = {};
  for (const d of dates) {
    if (d <= today) continue;
    try { schedule[d] = (await memo("sch:" + d, 6 * 3600 * 1000, () => scoreboard(d))).map((g) => [g.away, g.home]); } catch (e) { /* fine */ }
  }

  // projections and season-so-far averages for everyone in a lineup this week
  const proj = {};
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 300) {
      const rows = await supa.select("player_proj", "select=espn_id,gp,min,pts,reb,ast,stl,blk,tpm,fgm,fga,ftm,fta&espn_id=in.(" + ids.slice(i, i + 300).join(",") + ")").catch(() => []);
      rows.forEach((r) => { proj[r.espn_id] = { p: r }; });
    }
    for (let i = 0; i < ids.length; i += 300) {
      const rows = await supa.select("nba_box", "select=espn_id,played,min,pts,reb,ast,stl,blk,tpm,fgm,fga,ftm,fta,tov&played=eq.true&espn_id=in.(" + ids.slice(i, i + 300).join(",") + ")&limit=5000").catch(() => []);
      rows.forEach((r) => { const q = proj[r.espn_id] = proj[r.espn_id] || {}; const s = q.s = q.s || { gp: 0, min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tov: 0 }; s.gp++; ["min", "pts", "reb", "ast", "stl", "blk", "tpm", "fgm", "fga", "ftm", "fta", "tov"].forEach((k) => { s[k] += Number(r[k]) || 0; }); });
    }
  }

  // matchups + Yahoo's view, the cap
  const mu = await matchupsFor(meta, wk, false); if (mu.note) notes.push(mu.note);
  let cap = 30; try { const c = await supa.one("cap_table", "select=data&id=eq.current"); const w = c && c.data && c.data.weeks && c.data.weeks[wk - 1]; if (w && w.set != null && w.set !== "") cap = Number(w.set) || 30; } catch (e) { /* default */ }

  return {
    built: now(), season: meta.season, week: wk, currentWeek: cur, dates: dates, today: today, cap: cap,
    matchups: mu.rows.map((r) => ({ a: r.a, b: r.b, yahoo: r.yahoo, yahooAt: r.yahoo_at })),
    lineups: lineups, lineupAt: lineupAt || null, box: box, games: games, live: live, liveAt: liveAt, schedule: schedule, proj: proj, notes: notes, unmatched: unmatched,
    attribution: "Lineups from Yahoo Fantasy · box scores, play-by-play and projections from ESPN",
  };
}

// ---- one game ------------------------------------------------------------------
async function game(id) {
  const today = ledger.etDate();
  let g = (await scoreboard(today).catch(() => [])).find((x) => x.id === String(id));
  if (!g) {
    const sum0 = await espn("/summary?event=" + id);
    const ev = { id: id, date: ((sum0.header || {}).competitions || [])[0] && sum0.header.competitions[0].date, competitions: (sum0.header || {}).competitions, status: (((sum0.header || {}).competitions || [])[0] || {}).status, season: {} };
    g = gameFromEvent(ev);
  }
  const s = await summary(g);
  // owners: whoever holds the player in a lineup today (any slot)
  const own = {};
  try { const rows = await supa.select("lineup_days", "select=team_id,espn_id,pos&date=eq." + today + "&espn_id=not.is.null&limit=500"); rows.forEach((r) => { own[r.espn_id] = { team: r.team_id, pos: r.pos }; }); } catch (e) { /* no owners */ }
  const side = (tri) => ({ tri: tri, score: tri === g.home ? g.homeScore : g.awayScore, rows: (s.byTeam[tri] || []).slice().sort((x, y) => (y.starter - x.starter) || (y.min - x.min)) });
  return { built: now(), game: g, away: side(g.away), home: side(g.home), stints: s.stints, track: s.track, owners: own };
}

// ---- projections from ESPN's fantasy feed (nightly) ----------------------------
const PROJ_MAP = { 0: "pts", 1: "blk", 2: "stl", 3: "ast", 6: "reb", 13: "fgm", 14: "fga", 15: "ftm", 16: "fta", 17: "tpm", 40: "min", 42: "gp" };
async function projections(season) {
  const yr = Number(season) || new Date().getFullYear() + 1;
  const url = (process.env.ESPN_FANTASY_URL || "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba") + "/seasons/" + yr + "/segments/0/leaguedefaults/3?view=kona_player_info";
  const r = await fetch(url, { headers: { Accept: "application/json", "x-fantasy-filter": JSON.stringify({ players: { limit: 700, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" } } }) } });
  if (!r.ok) throw new Error("ESPN fantasy " + r.status);
  const j = await r.json();
  const rows = [];
  (j.players || []).forEach((x) => {
    const pl = x.player || {}; if (!pl.id) return;
    const st = (pl.stats || []).find((s) => s.statSourceId === 1 && s.statSplitTypeId === 0 && String(s.seasonId) === String(yr));
    if (!st) return;
    const a = st.averageStats || {}, t = st.stats || {}, row = { espn_id: Number(pl.id), name: pl.fullName || "", updated_at: now() };
    Object.keys(PROJ_MAP).forEach((k) => { row[PROJ_MAP[k]] = a[k] != null ? Math.round(Number(a[k]) * 100) / 100 : null; });
    row.gp = t[42] != null ? Math.round(Number(t[42])) : null;
    rows.push(row);
  });
  for (let i = 0; i < rows.length; i += 400) await supa.upsert("player_proj", rows.slice(i, i + 400), "espn_id");
  return rows.length;
}

module.exports = { week, refreshToday, refreshDays, game, projections, _parseSummary: parseSummary, _elapsed: elapsed, _gameFromEvent: gameFromEvent, _memo: cache };
