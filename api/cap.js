// Public: one team's week from the games ledger, in the same shape as
// /api/yahoo/team so the team page draws both the same way.
//   GET /api/cap?team=jalenba          the current week
//   GET /api/cap?team=jalenba&week=5   another week
// Lineups are what the last snapshot (or that manager's last visit) read from
// Yahoo; games played come from ESPN box scores. Cached a minute at the edge.
"use strict";

const supa = require("./_lib/supa");
const ledger = require("./_lib/ledger");

module.exports = async (req, res) => {
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
};
