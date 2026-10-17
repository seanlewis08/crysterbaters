// Minimal Supabase REST client using the service role key.
// Service role bypasses RLS, so every write here must set user_id /
// created_by explicitly to the linked manager — never trust the caller.
"use strict";

const URL_ = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers(extra) {
  return Object.assign(
    {
      apikey: KEY(),
      Authorization: "Bearer " + KEY(),
      "Content-Type": "application/json",
    },
    extra || {}
  );
}

async function rest(method, path, body, extra) {
  const res = await fetch(URL_() + "/rest/v1/" + path, {
    method,
    headers: headers(extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.hint || data.details)) || text || res.statusText;
    const err = new Error("Supabase " + method + " " + path + " → " + res.status + ": " + msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const select = (table, query) => rest("GET", table + "?" + query, undefined, { Prefer: "count=none" });
const one = async (table, query) => { const rows = await select(table, query + "&limit=1"); return rows && rows[0] ? rows[0] : null; };
const insert = (table, row) => rest("POST", table, row, { Prefer: "return=representation" });
const upsert = (table, row, onConflict) =>
  rest("POST", table + "?on_conflict=" + onConflict, row, { Prefer: "resolution=merge-duplicates,return=representation" });
const update = (table, query, patch) => rest("PATCH", table + "?" + query, patch, { Prefer: "return=representation" });
const remove = (table, query) => rest("DELETE", table + "?" + query, undefined, { Prefer: "return=minimal" });

// ---- domain helpers --------------------------------------------------

const TEAMS = [
  { id: "knuepp",  name: "The Knuepp Sluepps",          short: "Ben" },
  { id: "claxton", name: "Nic Claxton's Block Party",   short: "Anush" },
  { id: "rollins", name: "Shai See Me Rollins",         short: "David" },
  { id: "george",  name: "It's the Summer of George",   short: "Abada" },
  { id: "rucker",  name: "Rucker Legends",              short: "Tyler" },
  { id: "ant",     name: "Ant's Babymaking Factory",    short: "Gonzo" },
  { id: "ysga",    name: "Fun to Stay at the Y.S.G.A.", short: "Chris" },
  { id: "freaky",  name: "Real Freaky Naughty",         short: "Rajat" },
  { id: "giannis", name: "Regular Season Giannis",      short: "Kabir" },
  { id: "jalenba", name: "The JaleNBA",                 short: "Sean" },
];
const teamById = (id) => TEAMS.find((t) => t.id === id) || null;

// Same rule as the site's nameFor(): display_name, else the team's short
// name, else the email's local part.
function nameFor(profile, email) {
  if (profile) {
    if (profile.display_name) return profile.display_name;
    const t = teamById(profile.team_id);
    if (t) return t.short;
  }
  return email ? String(email).split("@")[0] : "Someone";
}

const profileByDiscord = (discordId) => one("profiles", "select=*&discord_id=eq." + encodeURIComponent(discordId));
const profileByTeam = (teamId) => one("profiles", "select=*&team_id=eq." + encodeURIComponent(teamId));
const profiles = () => select("profiles", "select=user_id,email,team_id,display_name,discord_id");

async function isCommissioner(profile) {
  if (!profile) return false;
  const s = await one("league_settings", "select=commissioner_email&id=eq.1");
  return !!(s && s.commissioner_email && s.commissioner_email.toLowerCase() === String(profile.email).toLowerCase());
}

const getPoll = (id) => one("polls", "select=*&id=eq." + id);
const getVotes = (pollId) => select("votes", "select=poll_id,user_id,voter_email,option_index,created_at&poll_id=eq." + pollId + "&order=created_at.asc");
const getMessage = (pollId) => one("poll_messages", "select=*&poll_id=eq." + pollId);

function pollIsOpen(p) {
  return !!p && !p.closed && (!p.closes_at || new Date(p.closes_at) > new Date());
}

module.exports = {
  rest, select, one, insert, upsert, update, remove,
  TEAMS, teamById, nameFor,
  profileByDiscord, profileByTeam, profiles, isCommissioner,
  getPoll, getVotes, getMessage, pollIsOpen,
};
