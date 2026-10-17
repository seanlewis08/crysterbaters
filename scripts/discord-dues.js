#!/usr/bin/env node
// Creates the 💸┃dues channel under FRONT OFFICE (read-only for members; the
// buttons still work), posts the dues board, and registers the /dues command.
// Re-runnable. Reads DISCORD_BOT_TOKEN (+ SYNC_SECRET for registering) from .env.
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
const dc = require("../api/_lib/discord");
const dues = require("../api/_lib/dues");
const GUILD = process.env.DISCORD_GUILD_ID || "1561010642561794068";
const APP_ID = process.env.DISCORD_APP_ID || "1561043044524888165";
const DRY = process.argv.includes("--dry");
const log = (...a) => console.log(...a);
const act = async (label, fn) => { log((DRY ? "  [dry] " : "  ") + label); if (!DRY) return fn(); };

(async () => {
  const chans = await dc.api("GET", "/guilds/" + GUILD + "/channels");
  const roles = await dc.api("GET", "/guilds/" + GUILD + "/roles");
  const botRole = roles.find((r) => r.tags && r.tags.bot_id === APP_ID);
  const cat = chans.find((c) => c.type === 4 && /front office/i.test(c.name));
  let ch = chans.find((c) => c.type === 0 && /dues/i.test(c.name));
  if (!ch) {
    ch = await act("+ channel 💸┃dues", () => dc.api("POST", "/guilds/" + GUILD + "/channels", {
      name: "💸┃dues", type: 0, parent_id: cat ? cat.id : undefined, position: 2,
      topic: "League dues: who's paid, who hasn't, and one tap to pay. Same numbers as crysterbaters.com/#dues.",
      permission_overwrites: [
        { id: GUILD, type: 0, deny: String(1n << 11n | 1n << 35n | 1n << 36n) },
        { id: botRole.id, type: 0, allow: String(1n << 11n | 1n << 13n) },
      ],
    }));
  } else log("  = #" + ch.name + " exists");
  if (ch) process.env.DISCORD_DUES_CHANNEL_ID = ch.id;

  if (!DRY) {
    const m = await dues.refreshBoard();
    log(m ? "  ~ board posted/refreshed (" + m.id + ")" : "  ! no active dues season on the site — set one on the Dues page, then re-run");
    if (m) { try { await dc.api("PUT", "/channels/" + ch.id + "/messages/pins/" + m.id); log("  📌 pinned"); } catch (_) { log("  ! pin the board by hand (bot lacks Pin Messages)"); } }
  }
  if (process.env.SYNC_SECRET && !DRY) {
    const r = await fetch("https://crysterbaters.com/api/discord-register?key=" + encodeURIComponent(process.env.SYNC_SECRET));
    log("  commands:", (await r.text()).slice(0, 200));
  } else log("  (set SYNC_SECRET in .env to register /dues from here, or open /api/discord-register?key=… once)");
  log(DRY ? "Dry run complete." : "Done.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
