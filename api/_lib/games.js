// The games log: for every team and every fantasy week so far, how many games its players
// played from starting slots (what counts against the weekly cap), how many were played on
// the bench (games left on the table), and the week's cap from the Games Cap table.
// Read by the Games Log page through /api/ledger?games=season.
"use strict";

const ledger = require("./ledger");

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

  const lines = await pages(supa, "lineup_days", "select=team_id,date,espn_id,pos&date=gte." + first + "&date=lte." + last + "&order=date.asc,team_id.asc,yahoo_key.asc");
  const ids = Array.from(new Set(lines.map((l) => l.espn_id).filter(Boolean)));
  const played = {};
  for (let i = 0; i < ids.length; i += 150) {
    const box = await pages(supa, "nba_box", "select=espn_id,date&played=is.true&date=gte." + first + "&date=lte." + last + "&espn_id=in.(" + ids.slice(i, i + 150).join(",") + ")&order=date.asc,espn_id.asc");
    box.forEach((b) => { played[b.espn_id + "|" + b.date] = 1; });
  }
  const weekOfDate = {};
  held.forEach((x) => ledger.daysBetween(x.start, x.end).forEach((d) => { weekOfDate[d] = x.w; }));

  // teams[id][w] = [games from starting slots, games on the bench, days we hold a lineup for]
  const teams = {}, seen = {};
  lines.forEach((l) => {
    const w = weekOfDate[l.date]; if (!w || !l.team_id) return;
    const t = teams[l.team_id] = teams[l.team_id] || {};
    const c = t[w] = t[w] || [0, 0, 0];
    const dk = l.team_id + "|" + l.date; if (!seen[dk]) { seen[dk] = 1; c[2]++; }
    if (!l.espn_id || !played[l.espn_id + "|" + l.date]) return;
    if (ledger.BENCH[l.pos]) c[1]++; else c[0]++;
  });
  return { built: new Date().toISOString(), season: meta.season, currentWeek: cur, today: today, weeks: weeks, teams: teams };
}

module.exports = { season, capFor, capRow };
