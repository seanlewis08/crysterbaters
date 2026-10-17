// Public: the league's teams as Yahoo has them right now — current team
// names and rosters — keyed by the site's permanent team ids so the page
// can swap them in over the names typed into index.html.
//   GET /api/teams            names + rosters
//   GET /api/teams?rosters=0  names only
// Cached for five minutes at the edge and in the warm function; nothing is
// written anywhere. Reads through the commissioner's shared Yahoo login.
"use strict";

const yahoo = require("./_lib/yahoo-server");

const TTL = 5 * 60 * 1000;
let cache = { at: 0, body: null };

// Yahoo lineup slot → the site's slot labels (G, F, C, Util, BN, IL).
function slot(pos) {
  if (/^(PG|SG|G)$/.test(pos)) return "G";
  if (/^(SF|PF|F)$/.test(pos)) return "F";
  if (pos === "C") return "C";
  if (/^(UTIL|Util)$/i.test(pos)) return "Util";
  if (/^(IL|IL\+|IR|NA)$/.test(pos)) return "IL";
  return "BN";
}
const ORDER = { G: 0, F: 1, C: 2, Util: 3, BN: 4, IL: 5 };

async function build(withRosters) {
  const [rosters, map] = await Promise.all([
    withRosters ? yahoo.leagueRosters() : yahoo.leagueTeams().then((ts) => ts.map((t) => Object.assign({ players: null }, t))),
    yahoo.mappedTeams(),
  ]);
  const idByKey = new Map(map.map((m) => [m.key, m.team_id]));
  const teams = rosters.map((t) => {
    const roster = t.players
      ? t.players
          .map((p) => [slot(p.pos), p.name, p.nba, p.status])
          .sort((a, b) => ORDER[a[0]] - ORDER[b[0]])
      : null;
    return { id: idByKey.get(t.key) || null, key: t.key, name: t.name, nick: t.nick, roster };
  });
  return { built: new Date().toISOString(), league: "nba.l.33689", teams };
}

module.exports = async (req, res) => {
  const withRosters = !(req.query && req.query.rosters === "0");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!withRosters || Date.now() - cache.at > TTL || !cache.body) {
      const body = await build(withRosters);
      if (withRosters) cache = { at: Date.now(), body };
      return res.status(200).json(body);
    }
    return res.status(200).json(cache.body);
  } catch (e) {
    console.error(e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: e.message || String(e), teams: [] });
  }
};

module.exports._test = { slot, build, reset: () => { cache = { at: 0, body: null }; } };
