// The #welcome pickers: favorite NBA team, favorite player, time zone and
// ping opt-ins, all as roles on the member. The message with the dropdowns
// is posted once by scripts/discord-welcome.js; the interactions land in
// api/discord.js and are handled here. Role names carry a prefix so each
// picker owns a "category" and picking a new value swaps the old one out:
//   🏀 <Team>   ⭐ <Player>   🕐 <Zone>   🔔 <Ping>
"use strict";

const dc = require("./discord");

const GUILD = () => process.env.DISCORD_GUILD_ID || "1561010642561794068";
const SITE = "https://crysterbaters.com";

// [abbr, name, colour, conference]. Colours are each team's primary, nudged
// where Discord would render it as "no colour" (pure black) or unreadable.
const NBA = [
  ["ATL", "Hawks", 0xC8102E, "E"], ["BOS", "Celtics", 0x007A33, "E"], ["BKN", "Nets", 0x6B6B6B, "E"], ["CHA", "Hornets", 0x00788C, "E"],
  ["CHI", "Bulls", 0xCE1141, "E"], ["CLE", "Cavaliers", 0x860038, "E"], ["DET", "Pistons", 0x1D42BA, "E"], ["IND", "Pacers", 0xFDBB30, "E"],
  ["MIA", "Heat", 0x98002E, "E"], ["MIL", "Bucks", 0x00471B, "E"], ["NY", "Knicks", 0xF58426, "E"], ["ORL", "Magic", 0x0077C0, "E"],
  ["PHI", "76ers", 0x006BB6, "E"], ["TOR", "Raptors", 0xCE1141, "E"], ["WSH", "Wizards", 0xE31837, "E"],
  ["DAL", "Mavericks", 0x00538C, "W"], ["DEN", "Nuggets", 0xFEC524, "W"], ["GS", "Warriors", 0x1D428A, "W"], ["HOU", "Rockets", 0xCE1141, "W"],
  ["LAC", "Clippers", 0xC8102E, "W"], ["LAL", "Lakers", 0x552583, "W"], ["MEM", "Grizzlies", 0x5D76A9, "W"], ["MIN", "Timberwolves", 0x236192, "W"],
  ["NO", "Pelicans", 0xC8102E, "W"], ["OKC", "Thunder", 0x007AC1, "W"], ["PHX", "Suns", 0xE56020, "W"], ["POR", "Trail Blazers", 0xE03A3E, "W"],
  ["SAC", "Kings", 0x5A2D81, "W"], ["SA", "Spurs", 0xC4CED4, "W"], ["UTA", "Jazz", 0xF9A01B, "W"],
];
const ZONES = [
  ["pacific", "Pacific", "🌉"], ["mountain", "Mountain", "🏔️"], ["central", "Central", "🌽"], ["eastern", "Eastern", "🗽"], ["elsewhere", "Elsewhere", "🌍"],
];
const PINGS = [
  ["news", "News Pings", "📰", "Injury and lineup news from RotoWire"],
  ["rumors", "Rumor Pings", "🗣️", "Hoops Rumors"],
  ["shams", "Shams Pings", "💣", "When Shams breaks something"],
  ["polls", "Poll Pings", "🗳️", "New league votes"],
];
const PREFIX = { team: "🏀 ", player: "⭐ ", zone: "🕐 ", ping: "🔔 " };

const teamRole = (t) => PREFIX.team + t[1];
const zoneRole = (z) => PREFIX.zone + z[1];
const pingRole = (p) => PREFIX.ping + p[1];

// Every role the pickers need, for the setup script.
function roleSpecs() {
  return [
    ...NBA.map((t) => ({ name: teamRole(t), color: t[2], hoist: false, mentionable: false })),
    ...ZONES.map((z) => ({ name: zoneRole(z), color: 0x546E7A, hoist: false, mentionable: false })),
    ...PINGS.map((p) => ({ name: pingRole(p), color: 0, hoist: false, mentionable: true })),
  ];
}

// The #welcome message. Five action rows is Discord's maximum.
function welcomeMessage(opts = {}) {
  const draft = opts.draft || "Sat Oct 17 · 3:00 PM PT";
  const teamSelect = (conf, id, placeholder) => ({
    type: 1, components: [{
      type: 3, custom_id: id, placeholder, min_values: 1, max_values: 1,
      options: NBA.filter((t) => t[3] === conf).map((t) => ({ label: t[1], value: t[0] })),
    }],
  });
  return {
    content: [
      "# Welcome to the Crysterbaters",
      "Ten teams, one ring, far too many group chats. The site has everything that matters: standings, keepers, dues, the draft board and the receipts.",
      "",
      "**Start here**",
      "1. Claim your team on the site → <" + SITE + "/#signup>",
      "2. Type `/link` in any channel and pick your team so polls here count for you.",
      "3. Pick your colours below. Favorite team becomes your role colour, and the time zone helps us schedule things.",
      "",
      "🎥 **Live draft:** " + draft + " in the Draft Room. Cameras on.",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    components: [
      teamSelect("E", "fav:team:E", "Favorite NBA team · East"),
      teamSelect("W", "fav:team:W", "Favorite NBA team · West"),
      { type: 1, components: [{ type: 3, custom_id: "fav:zone", placeholder: "Your time zone", min_values: 1, max_values: 1,
        options: ZONES.map((z) => ({ label: z[1], value: z[0], emoji: { name: z[2] } })) }] },
      { type: 1, components: [{ type: 3, custom_id: "fav:ping", placeholder: "Ping me for… (pick any)", min_values: 0, max_values: PINGS.length,
        options: PINGS.map((p) => ({ label: p[1], value: p[0], description: p[3], emoji: { name: p[2] } })) }] },
      { type: 1, components: [
        { type: 2, style: 1, custom_id: "fav:player", label: "Set favorite player", emoji: { name: "⭐" } },
        { type: 2, style: 5, label: "Open the site", url: SITE },
      ] },
    ],
  };
}

const playerModal = () => ({
  custom_id: "fav:player:modal",
  title: "Favorite player",
  components: [{ type: 1, components: [{
    type: 4, custom_id: "name", style: 1, label: "Who's your guy?", placeholder: "e.g. Luka Doncic", min_length: 2, max_length: 30, required: true,
  }] }],
});

// "luka  DONCIC jr." → "Luka Doncic Jr."; short all-caps like "CJ" or "RJ" stay as typed.
function cleanPlayerName(raw) {
  const s = String(raw || "").normalize("NFKC").replace(/[^\p{L}\p{M}' .-]/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 30 || !/\p{L}/u.test(s)) return null;
  return s.split(" ").map((w) => {
    if (w.length <= 3 && w === w.toUpperCase() && /^\p{L}+$/u.test(w)) return w;
    return w.toLowerCase().replace(/(^|[-'.])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  }).join(" ");
}

// ---------- role plumbing ----------
async function guildRoles() { return dc.api("GET", "/guilds/" + GUILD() + "/roles"); }
const inCategory = (role, prefix) => typeof role.name === "string" && role.name.startsWith(prefix);

async function ensureRole(roles, name, color) {
  let r = roles.find((x) => x.name === name);
  if (!r) { r = await dc.api("POST", "/guilds/" + GUILD() + "/roles", { name, color, mentionable: false }); roles.push(r); }
  return r;
}

// Give the member exactly `keepIds` within a category: strip other roles of that prefix, add the new ones.
async function setCategory(userId, memberRoleIds, roles, prefix, keepIds) {
  const current = memberRoleIds.filter((id) => { const r = roles.find((x) => x.id === id); return r && inCategory(r, prefix); });
  for (const id of current) if (!keepIds.includes(id)) await dc.api("DELETE", "/guilds/" + GUILD() + "/members/" + userId + "/roles/" + id);
  for (const id of keepIds) if (!current.includes(id)) await dc.api("PUT", "/guilds/" + GUILD() + "/members/" + userId + "/roles/" + id);
}

// ---------- interaction handlers: return { type, data } for the response ----------
const ephemeral = (content) => ({ type: dc.RT.CHANNEL_MESSAGE, data: { content, flags: dc.EPHEMERAL, allowed_mentions: { parse: [] } } });

async function handleComponent(ix) {
  const id = String(ix.data.custom_id || "");
  const user = (ix.member && ix.member.user) || ix.user || {};
  const memberRoles = (ix.member && ix.member.roles) || [];
  const values = ix.data.values || [];

  if (id === "fav:player") return { type: dc.RT.MODAL, data: playerModal() };

  const roles = await guildRoles();
  if (id.startsWith("fav:team:")) {
    const t = NBA.find((x) => x[0] === values[0]);
    if (!t) return ephemeral("Pick a team from the list.");
    const r = await ensureRole(roles, teamRole(t), t[2]);
    await setCategory(user.id, memberRoles, roles, PREFIX.team, [r.id]);
    return ephemeral("You're repping the **" + t[1] + "** now. Your name wears their colour.");
  }
  if (id === "fav:zone") {
    const z = ZONES.find((x) => x[0] === values[0]);
    if (!z) return ephemeral("Pick a zone from the list.");
    const r = await ensureRole(roles, zoneRole(z), 0x546E7A);
    await setCategory(user.id, memberRoles, roles, PREFIX.zone, [r.id]);
    return ephemeral(z[2] + " **" + z[1] + "** it is. We'll schedule around it.");
  }
  if (id === "fav:ping") {
    const picked = PINGS.filter((p) => values.includes(p[0]));
    const ids = [];
    for (const p of picked) ids.push((await ensureRole(roles, pingRole(p), 0)).id);
    await setCategory(user.id, memberRoles, roles, PREFIX.ping, ids);
    return ephemeral(picked.length ? "Pings on for: " + picked.map((p) => p[2] + " " + p[1].replace(" Pings", "")).join(", ") + "." : "All pings off. Peace and quiet.");
  }
  return null;   // not ours
}

async function handleModal(ix) {
  if (String(ix.data.custom_id) !== "fav:player:modal") return null;
  const user = (ix.member && ix.member.user) || ix.user || {};
  const memberRoles = (ix.member && ix.member.roles) || [];
  const field = (ix.data.components || []).flatMap((row) => row.components || []).find((c) => c.custom_id === "name");
  const name = cleanPlayerName(field && field.value);
  if (!name) return ephemeral("That doesn't look like a name. Letters, spaces and the odd apostrophe, 2–30 characters.");
  const roles = await guildRoles();
  const r = await ensureRole(roles, PREFIX.player + name, 0xF1C40F);
  await setCategory(user.id, memberRoles, roles, PREFIX.player, [r.id]);
  return ephemeral("⭐ **" + name + "** fan, noted. Change it any time with the same button.");
}

module.exports = { NBA, ZONES, PINGS, PREFIX, roleSpecs, welcomeMessage, playerModal, cleanPlayerName, handleComponent, handleModal, teamRole, zoneRole, pingRole };
