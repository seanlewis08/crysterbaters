// Server-side Yahoo reads with no browser cookie: the Discord functions and
// the games ledger (/api/ledger (POST)). Uses the one refresh token the
// commissioner shared via /api/yahoo/share, kept in discord_settings (service
// role only). What gets stored from Yahoo is limited to which Yahoo team key
// is which site team (team_map) and each team's daily lineup slots
// (lineup_days, see _lib/ledger.js); stats and games come from ESPN.
"use strict";

const L = require("../yahoo/_lib");
const supa = require("./supa");

const LEAGUE = "nba.l." + L.LEAGUE_ID;
let cached = null; // { at, exp } for this warm instance

async function accessToken() {
  if (cached && Date.now() < cached.exp) return cached.at;
  const s = await supa.one("discord_settings", "select=yahoo_refresh_token&id=eq.1");
  const rt = s && s.yahoo_refresh_token;
  if (!rt) throw new Error("Yahoo not connected for the server: visit /api/yahoo/share?key=… while connected to Yahoo on the site.");
  const fakeReq = { headers: { host: "crysterbaters.com" } };
  const t = await L.tokenRequest(fakeReq, { grant_type: "refresh_token", refresh_token: rt });
  if (t.rt && t.rt !== rt) {
    await supa.update("discord_settings", "id=eq.1", { yahoo_refresh_token: t.rt }).catch(() => {});
  }
  cached = { at: t.at, exp: t.exp };
  return t.at;
}

const list = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

// Live: [{ key, name, nick, logo }]
async function leagueTeams() {
  const at = await accessToken();
  const raw = await L.yahoo({ at }, "/league/" + LEAGUE + "/teams");
  const league = L.fold(raw.fantasy_content.league);
  return list(league.teams).map((x) => x.team || x).filter(Boolean).map((t) => {
    const mgr = list(t.managers).map((m) => m.manager || m)[0] || {};
    const logo = list(t.team_logos).map((l) => l.team_logo || l)[0] || {};
    return { key: t.team_key, name: t.name, nick: mgr.nickname || "", logo: logo.url || "" };
  });
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

// Live Yahoo teams joined to site team ids via team_map. Unmapped Yahoo teams
// are matched by current name, then by manager first name, and the match is
// saved so later renames don't matter. Returns [{ team_id|null, key, name, nick }].
async function mappedTeams() {
  const [teams, map] = await Promise.all([leagueTeams(), supa.select("team_map", "select=team_id,yahoo_team_key")]);
  const byKey = new Map(map.map((m) => [m.yahoo_team_key, m.team_id]));
  const taken = new Set(map.map((m) => m.team_id));
  const out = [];
  for (const t of teams) {
    let id = byKey.get(t.key) || null;
    if (!id) {
      const cand = supa.TEAMS.find((x) => !taken.has(x.id) && norm(x.name) === norm(t.name))
        || supa.TEAMS.find((x) => !taken.has(x.id) && t.nick && norm(x.mgr.split(" ")[0]) === norm(t.nick.split(" ")[0]));
      if (cand) {
        id = cand.id;
        taken.add(id);
        await supa.upsert("team_map", { team_id: id, yahoo_team_key: t.key, updated_at: new Date().toISOString() }, "team_id").catch(() => {});
      }
    }
    out.push({ team_id: id, key: t.key, name: t.name, nick: t.nick });
  }
  return out;
}

// Choices for the /link autocomplete: live names when Yahoo answers, the
// site's names otherwise. Always ≤ 25 and filtered by what was typed.
async function linkChoices(typed) {
  let rows;
  try {
    rows = (await mappedTeams()).map((t) => ({
      name: t.name + (t.nick ? " · " + t.nick : ""),
      value: t.team_id || "unmapped:" + t.key,
    }));
  } catch (e) {
    console.error("yahoo autocomplete fallback:", e.message);
    rows = supa.TEAMS.map((t) => ({ name: t.name + " · " + t.mgr.split(" ")[0], value: t.id }));
  }
  const q = norm(typed);
  const hit = q ? rows.filter((r) => norm(r.name).includes(q)) : rows;
  return (hit.length ? hit : rows).slice(0, 25).map((r) => ({ name: r.name.slice(0, 100), value: r.value }));
}

// Every team's current roster in one call: [{ key, name, nick, players:[{name,nba,pos,status}] }]
async function leagueRosters() {
  const at = await accessToken();
  const raw = await L.yahoo({ at }, "/league/" + LEAGUE + "/teams/roster");
  const league = L.fold(raw.fantasy_content.league);
  return list(league.teams).map((x) => x.team || x).filter(Boolean).map((t) => {
    const mgr = list(t.managers).map((m) => m.manager || m)[0] || {};
    const logo = list(t.team_logos).map((l) => l.team_logo || l)[0] || {};
    const ro = t.roster || {};
    const players = list(ro.players || (ro["0"] && ro["0"].players)).map((p) => {
      const pl = p.player || p;
      return {
        name: pl.name && pl.name.full,
        nba: pl.editorial_team_abbr || "",
        pos: (pl.selected_position && pl.selected_position.position) || "",
        status: pl.status || "",
      };
    }).filter((p) => p.name);
    return { key: t.team_key, name: t.name, nick: mgr.nickname || "", logo: logo.url || "", players };
  });
}

// The league's calendar: season, current/start/end week, start and end dates.
async function leagueMeta() {
  const at = await accessToken();
  const lg = L.fold((await L.yahoo({ at }, "/league/" + LEAGUE)).fantasy_content.league);
  return {
    league_key: lg.league_key || LEAGUE, season: String(lg.season || ""), name: lg.name || "",
    current_week: Number(lg.current_week) || 1, start_week: Number(lg.start_week) || 1, end_week: Number(lg.end_week) || Number(lg.current_week) || 1,
    start_date: lg.start_date || null, end_date: lg.end_date || null,
  };
}

// Yahoo's own dates for one week, from the scoreboard: [start, end] or null.
async function weekDates(week) {
  const at = await accessToken();
  try {
    const sb = L.fold((await L.yahoo({ at }, "/league/" + LEAGUE + "/scoreboard;week=" + week)).fantasy_content.league);
    const m = list(sb.scoreboard && (sb.scoreboard.matchups || (sb.scoreboard["0"] && sb.scoreboard["0"].matchups))).map((x) => x.matchup || x)[0];
    return m && m.week_start && m.week_end ? [m.week_start, m.week_end] : null;
  } catch (e) { return null; }
}

// Every team's lineup for one date: [{ key, name, players:[{key,name,nba,pos,status}] }]
// (one call for the whole league; the per-team fallback is the caller's business).
async function leagueRostersOn(date) {
  const at = await accessToken();
  const raw = await L.yahoo({ at }, "/league/" + LEAGUE + "/teams/roster;type=date;date=" + date);
  const league = L.fold(raw.fantasy_content.league);
  return list(league.teams).map((x) => x.team || x).filter(Boolean).map((t) => {
    const ro = t.roster || {};
    const players = list(ro.players || (ro["0"] && ro["0"].players)).map((p) => {
      const pl = p.player || p;
      return { key: pl.player_key || "", name: pl.name && pl.name.full, nba: pl.editorial_team_abbr || "", pos: (pl.selected_position && pl.selected_position.position) || "", status: pl.status || "" };
    }).filter((p) => p.name && p.key);
    return { key: t.team_key, name: t.name, date: (ro.date || date), players };
  });
}

// Current Yahoo name for a site team id (for messages), falling back to the site's name.
async function teamName(teamId) {
  try {
    const t = (await mappedTeams()).find((x) => x.team_id === teamId);
    if (t) return t.name;
  } catch (_) { /* fall through */ }
  const s = supa.teamById(teamId);
  return s ? s.name : teamId;
}

module.exports = { leagueTeams, leagueRosters, mappedTeams, linkChoices, teamName, leagueMeta, weekDates, leagueRostersOn, _reset: () => { cached = null; } };
