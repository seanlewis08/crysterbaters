// The games log: for every team and every fantasy week so far, how many games its players
// played from starting slots (what counts against the weekly cap), how many were played on
// the bench, the week's cap from the Games Cap table, and — for a finished week — the most
// games the team could have counted with the players it had.
// Read by the Games Log page through /api/ledger?games=season.
//
// "Could have": each day, the players on the roster that day (any slot but IL/IL+/IR/NA —
// starting one of those means freeing a roster spot first) who actually played, fitted into
// the league's starting slots by their Yahoo eligibility (a maximum matching, so three
// centers on one night fill C and Util, not three slots). The week's figure is the sum of
// those days, held to the cap. It is hindsight: a late scratch who was started while a
// bench player played still reads as a game that was there. Only finished weeks get one —
// a game left on the bench on Monday isn't lost while the rest of the week can still reach
// the cap. Free agents aren't counted: it is the roster as it was.
"use strict";

const ledger = require("./ledger");

const SLOTS = ["G", "G", "F", "F", "C", "Util"];
const OUT = { IL: 1, "IL+": 1, IR: 1, NA: 1 };
// listed out on the day: starting him anyway isn't a late scratch, it's a lineup left unset
const OUT_STATUS = /^(O|OUT|INJ|SUSP|NA|DTD-O)$/i;
// can a player with these eligible positions (Set; empty = unknown) sit in this slot? He can
// always sit where he actually sat that day; with nothing known about him, only Util as well.
function fits(slot, elig, sat) {
  if (slot === sat || slot === "Util") return true;
  if (!elig.size) return false;
  if (elig.has(slot)) return true;
  if (slot === "G") return elig.has("PG") || elig.has("SG");
  if (slot === "F") return elig.has("SF") || elig.has("PF");
  return false;
}
// the most of these players that fit into these slots at once (augmenting paths; a dozen players, six slots)
function maxFit(players, slots) {
  const owner = slots.map(() => -1);
  function place(i, seen) {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s] || !fits(slots[s], players[i].elig, players[i].sat)) continue;
      seen[s] = true;
      if (owner[s] < 0 || place(owner[s], seen)) { owner[s] = i; return true; }
    }
    return false;
  }
  let n = 0;
  for (let i = 0; i < players.length; i++) if (place(i, slots.map(() => false))) n++;
  return n;
}

// The Games Cap table is a run of Monday–Sunday NBA weeks from data.start. A fantasy week
// takes the row its first day falls in, so a week that spans two NBA weeks (All-Star) gets
// the first row's number and the rows after it stay lined up by date, not by position.
function capRow(capData, weekStart) {
  if (!capData || !Array.isArray(capData.weeks) || !capData.start || !weekStart) return null;
  const days = (Date.parse(weekStart + "T12:00:00Z") - Date.parse(capData.start + "T12:00:00Z")) / 864e5;
  if (!isFinite(days) || days < 0) return null;
  return capData.weeks[Math.floor(days / 7)] || null;
}
function capFor(capData, weekStart) {
  const r = capRow(capData, weekStart);
  const set = r && r.set != null && r.set !== "" && Number(r.set) > 0;
  return { cap: set ? Number(r.set) : 30, set: !!set, locked: !!(set && r.locked), note: (r && r.note) || "" };
}

async function pages(supa, table, q) {
  const out = [];
  for (let off = 0; off < 300000; off += 1000) {
    const p = await supa.select(table, q + "&limit=1000&offset=" + off);
    out.push.apply(out, p);
    if (p.length < 1000) break;
  }
  return out;
}

async function season(supa) {
  const meta = await supa.one("league_meta", "select=*&id=eq.current");
  if (!meta) throw new Error("no_snapshot");
  const wd = ledger.weekDates(meta);
  const cur = Number(meta.current_week) || 1, sw = Number(meta.start_week) || 1, ew = Math.max(Number(meta.end_week) || cur, cur);
  const today = ledger.etDate();
  let capData = null;
  try { const c = await supa.one("cap_table", "select=data&id=eq.current"); capData = c && c.data; } catch (e) { /* the normal 30 */ }

  const weeks = [];
  for (let w = sw; w <= ew; w++) {
    const r = wd[w]; if (!r) continue;
    const c = capFor(capData, r[0]);
    weeks.push({ w: w, start: r[0], end: r[1], cap: c.cap, set: c.set, locked: c.locked, note: c.note,
      state: w < cur ? "done" : (w === cur ? "live" : "ahead") });
  }
  const held = weeks.filter((x) => x.state !== "ahead");
  if (!held.length) return { built: new Date().toISOString(), season: meta.season, currentWeek: cur, today: today, weeks: weeks, teams: {} };
  const first = held[0].start, last = held[held.length - 1].end;

  const lines = await pages(supa, "lineup_days", "select=team_id,date,yahoo_key,espn_id,pos,status,nba&date=gte." + first + "&date=lte." + last + "&order=date.asc,team_id.asc,yahoo_key.asc");
  const ids = Array.from(new Set(lines.map((l) => l.espn_id).filter(Boolean)));
  // played[id|date] = 1 for a line he played; teamDay[NBA team|date] = 1 when that team played (seen
  // from any rostered player's line: a player on the inactive list has no line at all, so his own
  // box can't say whether his team played)
  const played = {}, teamDay = {};
  for (let i = 0; i < ids.length; i += 150) {
    const box = await pages(supa, "nba_box", "select=espn_id,date,played,nba&date=gte." + first + "&date=lte." + last + "&espn_id=in.(" + ids.slice(i, i + 150).join(",") + ")&order=date.asc,espn_id.asc");
    box.forEach((b) => { if (b.played) played[b.espn_id + "|" + b.date] = 1; if (b.nba) teamDay[b.nba + "|" + b.date] = 1; });
  }
  // eligibility: what the lineup reads stored, and Yahoo's players resource for anyone missing
  let elig = null, slots = SLOTS, notes = [];
  try {
    elig = {};
    (await pages(supa, "player_elig", "select=yahoo_key,elig&order=yahoo_key.asc")).forEach((r) => { if (r.elig) elig[r.yahoo_key] = r.elig; });
  } catch (e) { elig = null; notes.push("positions: the player_elig table isn't there yet (schema §17)"); }
  if (elig) {
    const doneStart = {}; weeks.forEach((x) => { if (x.state !== "ahead") ledger.daysBetween(x.start, x.end).forEach((d) => { if (d < today) doneStart[d] = 1; }); });
    const missing = Array.from(new Set(lines.filter((l) => doneStart[l.date] && !OUT[l.pos] && l.espn_id && played[l.espn_id + "|" + l.date] && !elig[l.yahoo_key]).map((l) => l.yahoo_key))).slice(0, 300);
    if (missing.length) {
      try {
        const got = await require("./yahoo-server").playersElig(missing);
        const now = new Date().toISOString(), rows = Object.keys(got).filter((k) => got[k]).map((k) => ({ yahoo_key: k, elig: got[k], updated_at: now }));
        rows.forEach((r) => { elig[r.yahoo_key] = r.elig; });
        if (rows.length) await supa.upsert("player_elig", rows, "yahoo_key").catch(() => {});
      } catch (e) { notes.push("positions: Yahoo lookup failed (" + (e.message || e) + ")"); }
    }
    try { const s = await require("./yahoo-server").rosterSlots(); if (s && s.length) slots = s; } catch (e) { /* the league's G G F F C Util */ }
  }

  const weekOfDate = {};
  held.forEach((x) => ledger.daysBetween(x.start, x.end).forEach((d) => { weekOfDate[d] = x.w; }));

  // teams[id][w] = [games from starting slots, games on the bench, days we hold a lineup for,
  //                 most games that fitted (before the cap; null without positions),
  //                 games played by players whose positions we don't know,
  //                 games counted on the days the fit covers,
  //                 late scratches on those days: starters whose team played but who didn't, and who
  //                 weren't listed out — the manager set a lineup that should have counted that game]
  // A finished week's fit covers every day; this week's covers the days already over (before
  // today), so the page can show what has been left on the bench so far.
  const teams = {}, seen = {}, avail = {};
  const state = {}; weeks.forEach((x) => { state[x.w] = x.state; });
  const fitDay = (w, d) => state[w] === "done" || (state[w] === "live" && d < today);
  lines.forEach((l) => {
    const w = weekOfDate[l.date]; if (!w || !l.team_id) return;
    const t = teams[l.team_id] = teams[l.team_id] || {};
    const c = t[w] = t[w] || [0, 0, 0, null, 0, 0, 0];
    const dk = l.team_id + "|" + l.date; if (!seen[dk]) { seen[dk] = 1; c[2]++; }
    const bk = l.espn_id + "|" + l.date;
    // a late scratch holds his slot in the best fit (the lineup was right when it was set) without counting
    if (l.espn_id && l.nba && teamDay[l.nba + "|" + l.date] && !played[bk] && !ledger.BENCH[l.pos] && !OUT_STATUS.test(l.status || "") && elig && fitDay(w, l.date)) {
      c[6]++;
      (avail[dk] = avail[dk] || []).push({ elig: new Set((elig[l.yahoo_key] || "").split(",").filter(Boolean)), sat: l.pos });
      return;
    }
    if (!l.espn_id || !played[bk]) return;
    if (ledger.BENCH[l.pos]) c[1]++; else { c[0]++; if (fitDay(w, l.date)) c[5]++; }
    if (elig && fitDay(w, l.date) && !OUT[l.pos]) {
      const e = elig[l.yahoo_key] || "";
      if (!e) c[4]++;
      (avail[dk] = avail[dk] || []).push({ elig: new Set(e.split(",").filter(Boolean)), sat: l.pos });
    }
  });
  if (elig) {
    Object.keys(teams).forEach((id) => Object.keys(teams[id]).forEach((w) => { if (state[w] !== "ahead") teams[id][w][3] = 0; }));
    Object.keys(avail).forEach((dk) => {
      const [id, date] = dk.split("|"), w = weekOfDate[date];
      teams[id][w][3] += maxFit(avail[dk], slots);
    });
  }
  // this season's records, from Yahoo's standings: records[id] = { rank, w, l, t, pct }
  const records = {};
  try {
    const ys = require("./yahoo-server");
    const [st, map] = await Promise.all([ys.standings(), ys.mappedTeams()]);
    const idByKey = {}; map.forEach((m) => { if (m.team_id) idByKey[m.key] = m.team_id; });
    st.forEach((s) => { const id = idByKey[s.key]; if (id) records[id] = { rank: s.rank, w: s.wins, l: s.losses, t: s.ties, pct: s.pct }; });
  } catch (e) { notes.push("records: " + (e.message || e)); }
  return { built: new Date().toISOString(), season: meta.season, currentWeek: cur, today: today, weeks: weeks, slots: slots, positions: !!elig, notes: notes, records: records, teams: teams };
}

module.exports = { season, capFor, capRow, maxFit, fits };
