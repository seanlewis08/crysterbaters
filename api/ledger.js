// The games ledger, one function (the Hobby plan allows twelve per deployment):
//   GET  /api/ledger?draft=1                 this season's draft, every pick with names
//   GET  /api/ledger?adp=1[&pages=12]        Yahoo's draft analysis (ADP, preseason rank) for the top of the pool
//   GET  /api/ledger?rotations=sync          bring rotation_games/rotation_players up to date with
//        popcornmachine's published games (a dozen per call; the Rotations page calls it on open,
//        the nightly run does the rest). Reads only that site, so its failures stay its own.
//   GET  /api/ledger?cast=week[&live=1]     the live scoreboard: every matchup's lineups for the
//        week, stored box scores plus today's live ones from ESPN, today's games, projections.
//        Cached a minute at the edge; today's lineups are re-read from Yahoo when stale.
//   GET  /api/ledger?cast=lineups            the page's "Refresh lineups from Yahoo" button
//   GET  /api/ledger?cast=game&id=<espn id>  one game: box scores, stints, score margin
//   GET  /api/ledger?team=jalenba[&week=5]   one team's week, in /api/yahoo/team's
//        shape, so the page draws stored and live data the same way. Lineups are
//        what the last snapshot (or that manager's last visit) read from Yahoo;
//        games played come from ESPN box scores. Cached a minute at the edge.
//   POST /api/ledger  (or the nightly cron, or ?key=SYNC_SECRET)   the snapshot run:
//     1. the league's calendar from Yahoo → league_meta
//     2. every team's lineup for each day of the current week (and yesterday,
//        which may belong to last week on a Monday) → lineup_days
//     3. ESPN box scores for every date up to today that isn't complete yet → nba_box
//     4. a line in snapshot_runs
//   Who may run it: Vercel's cron (Authorization: Bearer CRON_SECRET), the
//   commissioner's browser (a Supabase session token whose email is the
//   commissioner's), or ?key=SYNC_SECRET by hand. Each step is idempotent, so
//   running it twice in a day is harmless; a run that hits the time budget just
//   leaves the rest for the next one.
"use strict";

const yahoo = require("./_lib/yahoo-server");
const supa = require("./_lib/supa");
const ledger = require("./_lib/ledger");
const rotation = require("./_lib/rotation");
const cast = require("./_lib/cast");

const BUDGET_MS = 50 * 1000;

async function callerIsCommissioner(req) {
  const auth = req.headers.authorization || "";
  const cron = process.env.CRON_SECRET || "";
  if (cron && auth === "Bearer " + cron) return "cron";
  const sync = process.env.SYNC_SECRET || "";
  const key = (req.query && req.query.key) || "";
  if (sync && key === sync) return "key";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return null;
  // a site session: ask Supabase who it is, then compare with league_settings
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !anon) return null;
  const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + m[1] } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json().catch(() => ({}));
  const s = await supa.one("league_settings", "select=commissioner_email&id=eq.1");
  return u && u.email && s && s.commissioner_email && u.email.toLowerCase() === s.commissioner_email.toLowerCase() ? "commissioner" : null;
}

async function snapshot(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const who = await callerIsCommissioner(req).catch(() => null);
  if (!who) return res.status(401).json({ error: "commissioner only" });
  const t0 = Date.now(), deadline = t0 + BUDGET_MS;
  const out = { source: who, teams: 0, days: 0, box: 0, boxDays: [], notes: [] };
  let runId = null;
  try {
    const run = await supa.insert("snapshot_runs", { source: who, note: "running" }).catch(() => null);
    runId = run && run[0] && run[0].id;

    // 1. calendar
    const meta = await yahoo.leagueMeta();
    const prev = await supa.one("league_meta", "select=weeks&id=eq.current");
    const weeks = Object.assign({}, (prev && prev.weeks) || {});
    const wd = await yahoo.weekDates(meta.current_week);
    if (wd) weeks[meta.current_week] = wd;
    await supa.upsert("league_meta", Object.assign({ id: "current", weeks: weeks, updated_at: new Date().toISOString() }, meta), "id");
    const metaRow = Object.assign({ weeks: weeks }, meta);
    const dates = ledger.weekDates(metaRow)[meta.current_week];
    const today = ledger.etDate();
    const yesterday = ledger.addDays(today, -1);
    const want = dates ? ledger.daysBetween(dates[0], dates[1]) : [today];
    if (want.indexOf(yesterday) < 0 && yesterday >= (meta.start_date || yesterday)) want.unshift(yesterday);
    // past weeks never change; don't ask Yahoo for days before yesterday unless this is the first run
    const have = await supa.select("lineup_days", "select=date&date=in.(" + want.join(",") + ")&limit=1");
    const askDays = have.length ? want.filter((d) => d >= yesterday) : want;

    // 2. lineups
    const map = await yahoo.mappedTeams();
    const idByKey = {}; map.forEach((m) => { if (m.team_id) idByKey[m.key] = m.team_id; });
    const perTeam = {};
    for (const date of askDays) {
      if (Date.now() > deadline) { out.notes.push("time budget hit before " + date); break; }
      let teams;
      try { teams = await yahoo.leagueRostersOn(date); }
      catch (e) { out.notes.push("Yahoo " + date + ": " + e.message); continue; }
      teams.forEach((t) => {
        const id = idByKey[t.key]; if (!id) return;
        (perTeam[id] = perTeam[id] || []).push({ date: date, players: t.players.map((p) => ({ key: p.key, name: p.name, team: p.nba, pos: p.pos, status: p.status })) });
      });
      out.days++;
    }
    for (const id of Object.keys(perTeam)) {
      try { await ledger.writeLineups(id, perTeam[id]); out.teams++; }
      catch (e) { out.notes.push("store " + id + ": " + e.message); }
    }
    const unmappedTeams = map.filter((m) => !m.team_id).map((m) => m.name);
    if (unmappedTeams.length) out.notes.push("Yahoo teams with no site team: " + unmappedTeams.join(", "));

    // 3. box scores: every date in range up to today that isn't complete, oldest first
    const span = ledger.daysBetween(want[0], want[want.length - 1]).filter((d) => d <= today);
    const doneRows = await supa.select("nba_days", "select=date,done&date=in.(" + span.join(",") + ")");
    const done = {}; doneRows.forEach((r) => { if (r.done) done[r.date] = 1; });
    for (const date of span) {
      if (done[date]) continue;
      if (Date.now() > deadline) { out.notes.push("time budget hit before box scores for " + date); break; }
      try { const r = await ledger.fetchBox(date, deadline); out.box += r.rows; out.boxDays.push(date + ":" + r.finals + "/" + r.games + (r.done ? "" : " (open)")); }
      catch (e) { out.notes.push("ESPN " + date + ": " + e.message); }
    }

    // 3b. projections from ESPN's fantasy feed, once a day (a failure is noted, not fatal)
    try {
      const pr = await supa.select("player_proj", "select=updated_at&order=updated_at.desc&limit=1").catch(() => []);
      const age = pr[0] && pr[0].updated_at ? Date.now() - new Date(pr[0].updated_at).getTime() : Infinity;
      if (age > 20 * 3600 * 1000 && Date.now() < deadline) { out.proj = await cast.projections(Number(meta.season) + 1); }
    } catch (e) { out.notes.push("projections: " + e.message); }

    // 4. rotations from popcornmachine (separate source; a failure here is noted, not fatal)
    try { const r = await rotation.sync({ deadline: deadline, limit: 40 }); out.rotations = r.added.length; if (r.skipped.length) out.notes.push("rotations skipped: " + r.skipped.slice(0, 3).join("; ")); if (r.notes.length) out.notes.push("rotations: " + r.notes.join("; ")); }
    catch (e) { out.notes.push("popcornmachine: " + e.message); }

    out.ms = Date.now() - t0;
    if (runId) await supa.update("snapshot_runs", "id=eq." + runId, { finished_at: new Date().toISOString(), teams: out.teams, days: out.days, box: out.box, note: out.notes.join(" | ").slice(0, 900) }).catch(() => {});
    return res.status(200).json(out);
  } catch (e) {
    if (runId) await supa.update("snapshot_runs", "id=eq." + runId, { finished_at: new Date().toISOString(), note: ("failed: " + e.message).slice(0, 900) }).catch(() => {});
    return res.status(502).json(Object.assign(out, { error: e.message || String(e) }));
  }
}

async function read(req, res) {
  const q = req.query || {};
  const team = String(q.team || "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!supa.teamById(team)) { res.setHeader("Cache-Control", "no-store"); return res.status(400).json({ error: "unknown team" }); }
  try {
    const d = await ledger.readTeamWeek(team, Number(q.week) || 0);
    if (!d) { res.setHeader("Cache-Control", "no-store"); return res.status(404).json({ error: "no_snapshot", detail: "The ledger is empty: the commissioner's nightly snapshot hasn't run yet." }); }
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(d);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: e.message || String(e) });
  }
}

async function draft(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const d = await yahoo.draftResults();
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(Object.assign({ built: new Date().toISOString(), attribution: "Fantasy data provided by Yahoo Fantasy" }, d));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: e.message || String(e) });
  }
}

async function adp(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const d = await yahoo.draftAnalysis(req.query.pages);
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json(Object.assign({ built: new Date().toISOString(), attribution: "Fantasy data provided by Yahoo Fantasy" }, d));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: e.message || String(e) });
  }
}

async function rotations(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const r = await rotation.sync({ deadline: Date.now() + 25000, limit: 15 });
    // the page calls this on open; the edge answers repeats for a while so a busy night can't fan out
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
    return res.status(200).json(Object.assign({ built: new Date().toISOString(), source: rotation._base() }, r));
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: e.message || String(e), source: rotation._base() });
  }
}

// GET /api/ledger?usage=season|10|5 — the league-wide usage table for the
// Players page's Advanced view (api/_lib/usage.js seasonTable). Half an hour at the edge.
async function usageTable(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const span = String(req.query.usage || "season");
  if (!/^(season|5|10|15|20)$/.test(span)) { res.setHeader("Cache-Control", "no-store"); return res.status(400).json({ error: "usage=season|5|10|15|20" }); }
  try {
    const usage = require("./_lib/usage");
    const t = await usage.seasonTable(supa, { last: span === "season" ? 0 : Number(span) });
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(t);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    const missing = /usage_(games|players)/.test(e.message || "") && /does not exist|relation|42P01/.test(e.message || "");
    return res.status(missing ? 404 : 503).json({ error: missing ? "no_usage" : (e.message || String(e)) });
  }
}

async function scoreboard(req, res) {
  const q = req.query || {}, mode = String(q.cast || "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (mode === "week") {
      const d = await cast.week({ week: Number(q.week) || 0, live: !!q.live });
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
      return res.status(200).json(d);
    }
    if (mode === "lineups") {
      res.setHeader("Cache-Control", "no-store");
      // the button re-reads today and the rest of this week, so a lineup set for Thursday shows up now
      let later = [];
      try { const meta = await supa.one("league_meta", "select=*&id=eq.current"); const wd = meta && ledger.weekDates(meta); const r0 = wd && wd[Number(meta.current_week) || 1]; const today = ledger.etDate(); if (r0) later = ledger.daysBetween(r0[0], r0[1]).filter((d) => d > today); } catch (e) { /* today alone */ }
      const r = await cast.refreshToday(false, later);
      return res.status(200).json(r);
    }
    if (mode === "game") {
      if (!/^\d{6,12}$/.test(String(q.id || ""))) { res.setHeader("Cache-Control", "no-store"); return res.status(400).json({ error: "game id" }); }
      const d = await cast.game(String(q.id));
      res.setHeader("Cache-Control", "public, s-maxage=" + (d.game.state === "post" ? 600 : 45) + ", stale-while-revalidate=120");
      return res.status(200).json(d);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "cast=week|lineups|game" });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    const msg = e.message || String(e);
    return res.status(msg === "no_snapshot" ? 404 : 503).json({ error: msg, detail: msg === "no_snapshot" ? "The ledger is empty: the nightly snapshot hasn't run yet." : undefined });
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET" && req.query && req.query.cast) return scoreboard(req, res);
  if (req.method === "GET" && req.query && req.query.team) return read(req, res);
  if (req.method === "GET" && req.query && req.query.rotations) return rotations(req, res);
  if (req.method === "GET" && req.query && req.query.usage) return usageTable(req, res);
  if (req.method === "GET" && req.query && req.query.draft) return draft(req, res);
  if (req.method === "GET" && req.query && req.query.adp) return adp(req, res);
  return snapshot(req, res);
};
