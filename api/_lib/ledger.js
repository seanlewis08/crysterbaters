// The games ledger: the league's daily lineups come from Yahoo (the only thing
// Yahoo alone knows), everything else — the schedule, who actually played, the
// box score — comes from ESPN's public site API. Both land in Supabase through
// the service role (see schema.sql §13). Three jobs live here:
//
//   writeLineups(teamId, days)       store a team's lineup for each day given
//   linkPlayers(rows)                Yahoo player → ESPN athlete id by name + NBA team
//   fetchBox(date)                   ESPN box scores for every final game on a date
//   readTeamWeek(teamId, week)       assemble the same shape /api/yahoo/team returns,
//                                    from the stored rows (for /api/ledger)
//
// Nothing here ever touches a token: callers pass in what Yahoo returned.
"use strict";

const supa = require("./supa");

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const BENCH = { BN: 1, IL: 1, "IL+": 1, IR: 1, NA: 1 };
const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

// ---- names -----------------------------------------------------------------
// "Jaren Jackson Jr." / "Jaren Jackson" / "jackson jr jaren" all meet in the middle.
const SUFFIX = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, v: 1 };
function nrm(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.'’`-]/g, "").replace(/[^a-z ]/g, " ").split(" ").filter((w) => w && !SUFFIX[w]).join(" ");
}
// Yahoo and ESPN spell a few NBA abbreviations differently.
const ABBR = { GSW: "GS", NOP: "NO", NYK: "NY", SAS: "SA", UTA: "UTAH", WAS: "WSH", PHO: "PHX" };
const abbr = (a) => { a = String(a || "").toUpperCase(); return ABBR[a] || a; };

// ---- dates (ET, the NBA's day) ---------------------------------------------
// A basketball day runs 6 AM ET to 6 AM ET: the West Coast game that tips at 10 PM ET
// still belongs to that night, and a manager in Pacific time watching it at midnight
// ET should not see the Scoreboard flip to tomorrow's slate under him. No NBA game
// tips between midnight and 6 AM ET, so game dates come out the same either way.
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const DAY_TURNS_AT_H = 6;
function etDate(d) {
  const t = new Date((d || new Date()).getTime() - DAY_TURNS_AT_H * 3600 * 1000);
  const o = {}; ET.formatToParts(t).forEach((p) => { o[p.type] = p.value; });
  return o.year + "-" + o.month + "-" + o.day;
}
function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Yahoo weeks: week 1 runs from opening day to the following Sunday, every later
// week Monday–Sunday. Returns {week: [start, end]} for start_week..end_week.
function weekDates(meta) {
  const out = {};
  if (!meta || !meta.start_date) return out;
  const s0 = new Date(meta.start_date + "T12:00:00Z");
  const sun1 = new Date(s0); sun1.setUTCDate(sun1.getUTCDate() + ((7 - sun1.getUTCDay()) % 7));
  const sw = Number(meta.start_week) || 1, ew = Math.max(Number(meta.end_week) || sw, sw);
  for (let w = sw; w <= ew; w++) {
    if (w <= 1) { out[w] = [s0.toISOString().slice(0, 10), sun1.toISOString().slice(0, 10)]; continue; }
    const a = new Date(sun1); a.setUTCDate(a.getUTCDate() + 1 + 7 * (w - 2));
    const b = new Date(a); b.setUTCDate(b.getUTCDate() + 6);
    out[w] = [a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)];
  }
  // Yahoo's own week dates, when a run has stored them, win over the derivation
  Object.keys((meta && meta.weeks) || {}).forEach((w) => { const v = meta.weeks[w]; if (Array.isArray(v) && v.length === 2) out[w] = v; });
  return out;
}
function weekOf(meta, ymd) {
  const wd = weekDates(meta);
  const w = Object.keys(wd).find((k) => wd[k][0] <= ymd && ymd <= wd[k][1]);
  return w ? Number(w) : null;
}
function daysBetween(a, b) { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }

// ---- players.json: the site's own ESPN ids ---------------------------------
let PJ = null;
function playersJson() {
  if (PJ) return PJ;
  try {
    const d = require("../../players.json");
    const ci = d.cols.indexOf("id"), cn = d.cols.indexOf("name"), ct = d.cols.indexOf("team");
    PJ = d.players.map((r) => ({ id: Number(r[ci]), name: r[cn], key: nrm(r[cn]), team: abbr(r[ct]) })).filter((c) => c.id > 0); // a rookie carried without an ESPN id yet (id 0) must not shadow his box-score line
  } catch (e) { PJ = []; }
  return PJ;
}

// ---- Yahoo player key → ESPN athlete id ------------------------------------
// rows: [{yahoo_key, player, nba}] (duplicates fine). Returns {yahoo_key: espn_id|null}.
// A name that matches exactly one ESPN player links at once; several matches are
// split by NBA team; a manual row in player_links is always kept. Names seen in a
// stored box score count too, so a rookie who isn't in players.json links after
// his first game.
async function linkPlayers(rows) {
  const want = {}; rows.forEach((r) => { if (r && r.yahoo_key) want[r.yahoo_key] = { player: r.player || "", nba: abbr(r.nba) }; });
  const keys = Object.keys(want); if (!keys.length) return {};
  const have = await supa.select("player_links", "select=yahoo_key,espn_id,how&yahoo_key=in.(" + keys.map((k) => '"' + k + '"').join(",") + ")");
  const out = {}; const byKey = {}; have.forEach((h) => { byKey[h.yahoo_key] = h; });
  const todo = keys.filter((k) => !(byKey[k] && (byKey[k].espn_id || byKey[k].how === "manual")));
  keys.forEach((k) => { if (byKey[k] && byKey[k].espn_id) out[k] = byKey[k].espn_id; });
  if (!todo.length) return out;
  // candidates: the Players snapshot plus whoever has a box-score line this season
  const cands = playersJson().slice();
  try {
    const boxNames = await supa.select("nba_box", "select=espn_id,name,nba&order=date.desc&limit=2000");
    const seen = {}; boxNames.forEach((b) => { if (!seen[b.espn_id]) { seen[b.espn_id] = 1; cands.push({ id: b.espn_id, name: b.name, key: nrm(b.name), team: abbr(b.nba) }); } });
  } catch (e) { /* the snapshot alone will do */ }
  const byName = {}; cands.forEach((c) => { (byName[c.key] = byName[c.key] || []).push(c); });
  const ups = [];
  todo.forEach((k) => {
    const w = want[k]; const key = nrm(w.player);
    let hits = byName[key] || [];
    // "P.J. Washington" vs "PJ Washington", "Nicolas Claxton" vs "Nic Claxton": fall back to last name + team
    if (!hits.length) { const last = key.split(" ").pop(); hits = cands.filter((c) => c.team === w.nba && c.key.split(" ").pop() === last && c.key[0] === key[0]); }
    const ids = {}; hits.forEach((h) => { ids[h.id] = h; });
    let pick = null; const uniq = Object.keys(ids);
    if (uniq.length === 1) pick = Number(uniq[0]);
    else if (uniq.length > 1) { const same = hits.filter((h) => h.team === w.nba); const u2 = {}; same.forEach((h) => { u2[h.id] = 1; }); if (Object.keys(u2).length === 1) pick = Number(Object.keys(u2)[0]); }
    out[k] = pick;
    ups.push({ yahoo_key: k, player: w.player, nba: w.nba, espn_id: pick, how: pick ? "auto" : "none", updated_at: new Date().toISOString() });
  });
  if (ups.length) await supa.upsert("player_links", ups, "yahoo_key").catch(() => {});
  return out;
}

// ---- Yahoo lineups in --------------------------------------------------------
// days: [{date, players:[{key,name,team,pos,status}]}] as /api/yahoo/team builds them.
async function writeLineups(teamId, days) {
  const rows = [];
  (days || []).forEach((d) => {
    if (!d || !d.date || d.error) return;
    (d.players || []).forEach((p) => { if (p && p.key && p.name) rows.push({ team_id: teamId, date: d.date, yahoo_key: p.key, player: p.name, nba: abbr(p.team), pos: p.pos || "", status: p.status || "" }); });
  });
  if (!rows.length) return 0;
  const links = await linkPlayers(rows);
  const now = new Date().toISOString();
  rows.forEach((r) => { r.espn_id = links[r.yahoo_key] || null; r.updated_at = now; });
  await supa.upsert("lineup_days", rows, "team_id,date,yahoo_key");
  // a player dropped mid-week must vanish from the days we just rewrote
  const byDate = {}; rows.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r.yahoo_key); });
  for (const date of Object.keys(byDate)) {
    await supa.remove("lineup_days", "team_id=eq." + encodeURIComponent(teamId) + "&date=eq." + date + "&yahoo_key=not.in.(" + byDate[date].map((k) => '"' + k + '"').join(",") + ")").catch(() => {});
  }
  return rows.length;
}

// ---- ESPN box scores in ------------------------------------------------------
async function espn(path) {
  const r = await fetch((process.env.ESPN_URL || ESPN) + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("ESPN " + r.status + " on " + path);
  return r.json();
}
function num(s) { const n = parseInt(String(s == null ? "" : s).split("-")[0], 10); return isNaN(n) ? 0 : n; }
function pair(s) { const m = /^(\d+)-(\d+)$/.exec(String(s || "")); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; }

// Every final game on `date` (ET) → nba_box rows. Returns {games, finals, rows}.
// A date is "done" once every scheduled game is final; the job re-reads an
// unfinished date on its next run.
async function fetchBox(date, deadline) {
  const sb = await espn("/scoreboard?dates=" + date.replace(/-/g, "") + "&limit=1000");
  const events = (sb.events || []).filter((ev) => etDate(new Date(ev.date)) === date && !(ev.season && ev.season.type === 1));
  let finals = 0; const rows = []; const now = new Date().toISOString();
  for (const ev of events) {
    const st = ev.status && ev.status.type || {};
    if (st.state !== "post") continue;
    if (deadline && Date.now() > deadline) break;
    let sum; try { sum = await espn("/summary?event=" + ev.id); } catch (e) { continue; }
    finals++;
    const comps = (((ev.competitions || [])[0] || {}).competitors || []);
    (sum.boxscore && sum.boxscore.players || []).forEach((side) => {
      const team = abbr(side.team && side.team.abbreviation);
      const me = comps.find((c) => abbr(c.team && c.team.abbreviation) === team) || {};
      const other = comps.find((c) => c !== me) || {};
      const stat = (side.statistics || [])[0] || {}; const labels = stat.labels || stat.names || [];
      const ix = {}; labels.forEach((l, i) => { ix[l] = i; });
      (stat.athletes || []).forEach((a) => {
        const id = Number(a.athlete && a.athlete.id); if (!id) return;
        const s = a.stats || []; const g = (l) => (ix[l] == null ? "" : s[ix[l]]);
        const fg = pair(g("FG")), tp = pair(g("3PT")), ft = pair(g("FT"));
        const played = !a.didNotPlay && s.length > 0 && (num(g("MIN")) > 0 || num(g("PTS")) > 0 || fg[1] > 0 || num(g("REB")) > 0);
        rows.push({ espn_id: id, date: date, name: a.athlete.displayName || "", nba: team, opp: abbr(other.team && other.team.abbreviation), home: me.homeAway === "home",
          played: played, min: num(g("MIN")), pts: num(g("PTS")), reb: num(g("REB")), ast: num(g("AST")), stl: num(g("STL")), blk: num(g("BLK")),
          tpm: tp[0], fgm: fg[0], fga: fg[1], ftm: ft[0], fta: ft[1], tov: num(g("TO")), event_id: String(ev.id), updated_at: now });
      });
    });
  }
  // a player can be listed in two games on one date (waived and signed the same
  // day: a DNP line on the old team, a real one on the new); one row per player
  // per date, the line he played taking precedence, or Postgres refuses the batch
  const byKey = {};
  rows.forEach((r) => { const k = r.espn_id + "|" + r.date; const have = byKey[k]; if (!have || (r.played && !have.played) || (r.played === have.played && r.min > have.min)) byKey[k] = r; });
  const uniq = Object.keys(byKey).map((k) => byKey[k]);
  if (uniq.length) { for (let i = 0; i < uniq.length; i += 400) await supa.upsert("nba_box", uniq.slice(i, i + 400), "espn_id,date"); }
  const done = events.length > 0 && finals === events.length;
  await supa.upsert("nba_days", { date: date, games: events.length, finals: finals, done: done, fetched_at: now }, "date").catch(() => {});
  return { games: events.length, finals: finals, rows: uniq.length, done: done };
}

// A player's injury status (O, Q, GTD...) is a fact about him today, not about a
// date: whichever stored row for him was written most recently carries the
// status Yahoo showed last, so every day's lineup and the week view wear that one.
function freshestStatus(rows) {
  const at = {}, out = {};
  (rows || []).forEach((l) => { const k = l.yahoo_key; if (!k) return; const u = l.updated_at || ""; if (at[k] == null || u > at[k]) { at[k] = u; out[k] = l.status || ""; } });
  return out;
}

// ---- read back, in /api/yahoo/team's shape ----------------------------------
async function readTeamWeek(teamId, wantWeek) {
  const meta = await supa.one("league_meta", "select=*&id=eq.current");
  if (!meta) return null;
  const wd = weekDates(meta);
  const cur = Number(meta.current_week) || 1, sw = Number(meta.start_week) || 1, ew = Number(meta.end_week) || cur;
  const week = Math.min(Math.max(Number(wantWeek) || cur, sw), ew);
  const range = wd[week]; if (!range) return null;
  const [lines, runs] = await Promise.all([
    supa.select("lineup_days", "select=date,yahoo_key,player,nba,pos,status,espn_id,updated_at&team_id=eq." + encodeURIComponent(teamId) + "&date=gte." + range[0] + "&date=lte." + range[1] + "&order=date.asc"),
    supa.select("snapshot_runs", "select=started_at,finished_at,source,teams,days,box,note&order=id.desc&limit=1"),
  ]);
  const ids = Array.from(new Set(lines.map((l) => l.espn_id).filter(Boolean)));
  const box = ids.length ? await supa.select("nba_box", "select=espn_id,date,played,opp,home,min,pts,reb,ast,stl,blk,tpm,fgm,fga,ftm,fta,tov&date=gte." + range[0] + "&date=lte." + range[1] + "&espn_id=in.(" + ids.join(",") + ")") : [];
  const bx = {}; box.forEach((b) => { bx[b.espn_id + "|" + b.date] = b; });
  const byDate = {}; lines.forEach((l) => { (byDate[l.date] = byDate[l.date] || []).push(l); });
  const status = freshestStatus(lines);
  let latest = null, asOf = null;
  const days = daysBetween(range[0], range[1]).map((date) => {
    const ps = (byDate[date] || []).map((l) => {
      const b = bx[l.espn_id + "|" + date];
      if (l.updated_at && (!asOf || l.updated_at > asOf)) asOf = l.updated_at;
      return { key: l.yahoo_key, name: l.player, team: l.nba, pos: l.pos, status: status[l.yahoo_key] != null ? status[l.yahoo_key] : l.status, gp: b && b.played ? 1 : 0, espn: l.espn_id || null, box: b ? { min: b.min, pts: b.pts, reb: b.reb, ast: b.ast, stl: b.stl, blk: b.blk, tpm: b.tpm, fgm: b.fgm, fga: b.fga, ftm: b.ftm, fta: b.fta, tov: b.tov, opp: b.opp, home: b.home } : null };
    });
    if (ps.length) latest = ps;
    return { date: date, players: ps, active: ps.filter((p) => !BENCH[p.pos]).reduce((a, p) => a + p.gp, 0), bench: ps.filter((p) => BENCH[p.pos]).reduce((a, p) => a + p.gp, 0) };
  });
  // the roster for the week is the latest day we hold, with the week's games played summed per player
  const gp = {}; days.forEach((d) => d.players.forEach((p) => { gp[p.key] = (gp[p.key] || 0) + p.gp; }));
  const players = (latest || []).map((p) => ({ key: p.key, name: p.name, team: p.team, pos: p.pos, status: p.status, elig: [], note: "", gp: gp[p.key] || 0, draft: null }));
  const unmapped = Array.from(new Set(lines.filter((l) => !l.espn_id).map((l) => l.player)));
  const team = supa.teamById(teamId) || { id: teamId, name: teamId };
  const run = runs && runs[0] || null;
  return {
    league: { id: String(meta.league_key || "").replace(/^.*\.l\./, ""), name: meta.name, week: week, currentWeek: cur, startWeek: sw, endWeek: ew, season: meta.season, start: meta.start_date, end: meta.end_date, draft: "", draftResults: false },
    team: { key: "", id: teamId, name: team.name, logo: "", faab: null, moves: 0, trades: 0, waiver: null },
    standing: null,
    matchup: { week: week, start: range[0], end: range[1] },
    lineup: { active: players.filter((p) => !BENCH[p.pos]).length, bench: players.filter((p) => p.pos === "BN").length, il: players.filter((p) => BENCH[p.pos] && p.pos !== "BN").length, injuredActive: players.filter((p) => !BENCH[p.pos] && p.status).length },
    games: { active: days.reduce((a, d) => a + d.active, 0), cap: 30, bench: days.reduce((a, d) => a + d.bench, 0) },
    players: players, days: days,
    unmapped: unmapped,
    source: "stored", asOf: asOf, run: run,
    warn: [],
    fetched: new Date().toISOString(),
    attribution: "Lineups from Yahoo Fantasy · box scores from ESPN",
  };
}

module.exports = { nrm, abbr, etDate, addDays, weekDates, weekOf, daysBetween, linkPlayers, writeLineups, fetchBox, readTeamWeek, BENCH, _playersJson: playersJson , freshestStatus };
