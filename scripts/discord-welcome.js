#!/usr/bin/env node
// Sets up the #welcome pickers: creates the 30 NBA-team roles (team colours),
// time-zone roles and ping roles, posts (or refreshes) the welcome message
// with the dropdowns, pins it, and removes the old Carl-bot reaction-role
// messages plus the East Coast / West Coast roles. Re-runnable.
//
//   node scripts/discord-welcome.js --dry
//   node scripts/discord-welcome.js
//
// Reads DISCORD_BOT_TOKEN from .env (gitignored). Needs Manage Roles and
// Manage Messages; the bot's role must sit above the roles it creates (it
// does: new roles go in below it).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const welcome = require("../api/_lib/welcome");
const dc = require("../api/_lib/discord");

const GUILD = process.env.DISCORD_GUILD_ID || "1561010642561794068";
const APP_ID = process.env.DISCORD_APP_ID || "1561043044524888165";
const WELCOME_CHANNEL = process.env.DISCORD_WELCOME_CHANNEL_ID || "1561030721089310872";
const CARL_BOT_ID = "235148962103951360";
const DRY = process.argv.includes("--dry");
const log = (...a) => console.log(...a);
const act = async (label, fn) => { log((DRY ? "  [dry] " : "  ") + label); if (!DRY) return fn(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN missing (put it in .env)");
  const roles = await dc.api("GET", "/guilds/" + GUILD + "/roles");
  const botRole = roles.find((r) => r.tags && r.tags.bot_id === APP_ID);
  log("Bot role position:", botRole && botRole.position);

  log("\n== Roles ==");
  let made = 0, kept = 0;
  for (const spec of welcome.roleSpecs()) {
    const r = roles.find((x) => x.name === spec.name);
    if (r) {
      if (r.color !== spec.color || r.mentionable !== spec.mentionable) await act("~ " + spec.name, () => dc.api("PATCH", "/guilds/" + GUILD + "/roles/" + r.id, { color: spec.color, mentionable: spec.mentionable }));
      else kept++;
    } else {
      await act("+ " + spec.name, () => dc.api("POST", "/guilds/" + GUILD + "/roles", { name: spec.name, color: spec.color, hoist: false, mentionable: spec.mentionable }));
      made++; await sleep(350);
    }
  }
  log("  " + made + " created, " + kept + " already right");
  for (const old of ["East Coast", "West Coast", "News Pings", "Rumor Pings", "Shams Pings"]) {
    const r = roles.find((x) => x.name === old);
    if (r && r.position < (botRole ? botRole.position : 999)) await act("- old role " + old, () => dc.api("DELETE", "/guilds/" + GUILD + "/roles/" + r.id));
  }

  log("\n== #welcome message ==");
  const msgs = await dc.api("GET", "/channels/" + WELCOME_CHANNEL + "/messages?limit=50");
  const mine = msgs.find((m) => m.author && m.author.id === APP_ID && /Welcome to the Crysterbaters/.test(m.content || ""));
  const body = welcome.welcomeMessage();
  let msg = mine;
  if (mine) await act("~ refresh existing welcome message", () => dc.api("PATCH", "/channels/" + WELCOME_CHANNEL + "/messages/" + mine.id, body));
  else msg = await act("+ post welcome message", () => dc.api("POST", "/channels/" + WELCOME_CHANNEL + "/messages", body));
  if (msg && !msg.pinned) { try { await act("📌 pin it", () => dc.api("PUT", "/channels/" + WELCOME_CHANNEL + "/messages/pins/" + msg.id)); } catch (e) { log("  ! pin needs the Pin Messages permission; pin it by hand"); } }
  for (const m of msgs) {
    if (m.author && (m.author.id === CARL_BOT_ID || (m.author.bot && /carl/i.test(m.author.username || "")))) await act("- old Carl-bot message " + m.id, () => dc.api("DELETE", "/channels/" + WELCOME_CHANNEL + "/messages/" + m.id));
  }
  log("\n" + (DRY ? "Dry run complete." : "Done. Pickers are live in #welcome."));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
