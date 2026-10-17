#!/usr/bin/env node
// One-shot (and re-runnable) theming for the Crysterbaters Discord server:
// custom emoji from the league logo and each team's Yahoo logo, team-coloured
// hoisted roles, earned roles, channel categories with emoji prefixes, a
// forum for trade proposals, read-only #hall-of-fame with the champions list,
// and a #site-updates webhook. Runs on the commissioner's machine with the
// bot token read from .env (never committed). Everything is idempotent:
// existing emoji/roles/channels are matched by name and updated, not duplicated.
//
//   node scripts/discord-theme.js --dry     show the plan, change nothing
//   node scripts/discord-theme.js           apply
//   node scripts/discord-theme.js --only emoji,roles,channels,hof,webhook
//
// The bot needs: Manage Roles, Manage Channels, Manage Expressions / Create
// Expressions, Manage Messages, Manage Webhooks, Send Messages, Embed Links,
// Read Message History. Its role must sit ABOVE the ten team roles.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const env = Object.assign({}, process.env);
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const TOKEN = env.DISCORD_BOT_TOKEN;
const GUILD = env.DISCORD_GUILD_ID || "1561010642561794068";
const APP_ID = env.DISCORD_APP_ID || "1561043044524888165";
const SITE = "https://crysterbaters.com";
const DRY = process.argv.includes("--dry");
const onlyArg = process.argv[process.argv.indexOf("--only") + 1];
const ONLY = process.argv.includes("--only") ? new Set(onlyArg.split(",")) : null;
const want = (k) => !ONLY || ONLY.has(k);
if (!TOKEN) { console.error("DISCORD_BOT_TOKEN missing: put it in .env (gitignored) as DISCORD_BOT_TOKEN=..."); process.exit(1); }

// ---------- league data (mirrors index.html / api/_lib/supa.js) ----------
const TEAMS = [
  { id: "jalenba", role: "The JaleNBA", emoji: "jalenba", color: 0x1fb6d6, mgr: "Sean", titles: [2016, 2025] },
  { id: "rollins", role: "Shai See Me Rollins", emoji: "rollins", color: 0x2f3b52, mgr: "David", titles: [2018, 2019] },
  { id: "george", role: "It's the Summer of George", emoji: "george", color: 0x5b5ba6, mgr: "Abada", titles: [] },
  { id: "claxton", role: "Nic Claxton's Block Party", emoji: "claxton", color: 0xe64ba8, mgr: "Anush", titles: [2020] },
  { id: "freaky", role: "Real Freaky Naughty", emoji: "freaky", color: 0xf2c230, mgr: "Rajat", titles: [2017] },
  { id: "rucker", role: "Rucker Legends", emoji: "rucker", color: 0xa7b1bc, mgr: "Tyler", titles: [] },
  { id: "ysga", role: "Fun to Stay at the Y.S.G.A.", emoji: "ysga", color: 0x5fbf4a, mgr: "Chris", titles: [2015] },
  { id: "giannis", role: "Regular Season Giannis", emoji: "giannis", color: 0xce1141, mgr: "Kabir", titles: [2013, 2023] },
  { id: "knuepp", role: "The Knuepp Sluepps", emoji: "knuepp", color: 0x3b63f0, mgr: "Ben", titles: [2021, 2024] },
  { id: "ant", role: "Ant's Babymaking Factory", emoji: "ant", color: 0xf0893a, mgr: "Gonzo", titles: [2022] },
];
const EARNED = [
  { name: "Commissioner", color: 0xc1571a, hoist: true },
  { name: "🏆 Champion", color: 0xf1c40f, hoist: true },
  { name: "🥄 Last Place", color: 0x7f8c8d, hoist: false },
  { name: "🦈 Trade Shark", color: 0x1abc9c, hoist: false },
  { name: "💤 Forgot To Set A Lineup", color: 0x546e7a, hoist: false },
];
// Channel layout. `was` = the current name to rename from (matched case-insensitively, ignoring emoji prefixes).
const LAYOUT = [
  { category: "🗳️ FRONT OFFICE", channels: [
    { name: "👋┃welcome", was: "welcome" },
    { name: "🏆┃hall-of-fame", was: "hall-of-fame", readonly: true, topic: "Every Crysterbaters champion. Read-only; argue about it in #trash-talk." },
    { name: "📊┃polls", was: "polls", topic: "League votes. Tap a button here or vote on " + SITE + " — same poll either way." },
    { name: "🛠┃site-updates", was: "site-updates", readonly: true, topic: "Deploys and site events from " + SITE + ". Bots only." },
  ] },
  { category: "🏟️ THE ARENA", channels: [
    { name: "🏀┃general", was: "general" },
    { name: "📋┃draft-chat", was: "draft-chat", topic: "Draft-day chatter. Board, keepers and pick order: " + SITE },
    { name: "🔁┃trade-block", was: "trade-block", forum: true, topic: "One post per proposal. Tag it Open while you're shopping, Done when it goes through, Dead when it dies." },
    { name: "🗑️┃trash-talk", was: "trash-talk", topic: "No slowmode. No mercy. What's said here stays here." },
  ] },
  { category: "📡 THE WIRE", channels: [
    { name: "📰┃nba-news", was: "nba-news" },
    { name: "💣┃shams", was: "shams" },
    { name: "🗣️┃rumor-mill", was: "rumor-mill" },
  ] },
  { category: "🎙️ COURTSIDE", voice: true, channels: [
    { name: "🔊 Courtside", was: "General" },
    { name: "🎥 Draft Room", was: "Draft Room" },
  ] },
];

// ---------- tiny Discord client ----------
const API = "https://discord.com/api/v10";
async function dc(method, p, body, raw) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(API + p, {
      method,
      headers: Object.assign({ Authorization: "Bot " + TOKEN, "X-Audit-Log-Reason": "crysterbaters theme script" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after || 1) * 1000 + 100); continue; }
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
    if (!r.ok) { const e = new Error(method + " " + p + " → " + r.status + " " + JSON.stringify(json).slice(0, 300)); e.status = r.status; e.body = json; throw e; }
    return json;
  }
  throw new Error("rate limited too long: " + p);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const act = async (label, fn) => { log((DRY ? "  [dry] " : "  ") + label); if (!DRY) return fn(); };
const stripEmoji = (s) => s.replace(/^[^a-z0-9]*/i, "").toLowerCase();
const sameName = (a, b) => stripEmoji(a) === stripEmoji(b);

(async () => {
  const guild = await dc("GET", "/guilds/" + GUILD);
  log("Server:", guild.name, "| boost tier", guild.premium_tier, "| features:", (guild.features || []).join(",") || "none");
  let roles = await dc("GET", "/guilds/" + GUILD + "/roles");
  const botRole = roles.find((r) => r.tags && r.tags.bot_id === APP_ID);
  if (!botRole) throw new Error("the Crysterbaters Polls bot's role was not found in this server");
  const everyone = roles.find((r) => r.id === GUILD);
  log("Bot role:", botRole.name, "position", botRole.position, "perms", botRole.permissions);
  const perms = BigInt(botRole.permissions);
  const need = { MANAGE_CHANNELS: 1n << 4n, MANAGE_ROLES: 1n << 28n, MANAGE_EXPRESSIONS: 1n << 30n, MANAGE_MESSAGES: 1n << 13n, MANAGE_WEBHOOKS: 1n << 29n };
  const missing = Object.keys(need).filter((k) => !(perms & need[k]) && !(perms & 8n));
  if (missing.length) log("!! bot is missing permissions:", missing.join(", "), "— re-authorize it with the link in the docs, then re-run");

  // ---------- emoji ----------
  if (want("emoji")) {
    log("\n== Emoji ==");
    const have = new Set((await dc("GET", "/guilds/" + GUILD + "/emojis")).map((e) => e.name));
    const teams = (await (await fetch(SITE + "/api/teams?rosters=0")).json()).teams || [];
    const uploads = [{ name: "cb", file: path.join(ROOT, "brand/emoji/cb.png") }, { name: "keeper", file: path.join(ROOT, "brand/emoji/keeper.png") },
      { name: "deadcap", file: path.join(ROOT, "brand/emoji/deadcap.png") }, { name: "commish", file: path.join(ROOT, "brand/emoji/commish.png") }];
    for (const t of TEAMS) { const live = teams.find((x) => x.id === t.id); if (live && live.logo) uploads.push({ name: t.emoji, url: live.logo }); }
    for (const u of uploads) {
      if (have.has(u.name)) { log("  = :" + u.name + ": exists"); continue; }
      let buf, type;
      if (u.file) { if (!fs.existsSync(u.file)) { log("  ! missing", u.file); continue; } buf = fs.readFileSync(u.file); type = "image/png"; }
      else { const r = await fetch(u.url, { headers: { "User-Agent": "Mozilla/5.0 crysterbaters-theme" } }); if (!r.ok) { log("  ! fetch failed", u.url); continue; } buf = Buffer.from(await r.arrayBuffer()); type = (r.headers.get("content-type") || "image/png").split(";")[0]; }
      if (buf.length > 256 * 1024) { log("  ! :" + u.name + ": is " + buf.length + " bytes (> 256 KB), skipped"); continue; }
      await act("+ :" + u.name + ": (" + buf.length + " bytes)", () => dc("POST", "/guilds/" + GUILD + "/emojis", { name: u.name, image: "data:" + type + ";base64," + buf.toString("base64") }));
      await sleep(400);
    }
  }

  // ---------- roles ----------
  if (want("roles")) {
    log("\n== Roles ==");
    const tooHigh = [];
    for (const t of TEAMS) {
      const r = roles.find((x) => x.name === t.role);
      if (!r) { await act("+ team role " + t.role, () => dc("POST", "/guilds/" + GUILD + "/roles", { name: t.role, color: t.color, hoist: true, mentionable: true })); continue; }
      if (r.position >= botRole.position) { tooHigh.push(r.name); continue; }
      if (r.color !== t.color || !r.hoist) await act("~ " + t.role + " → #" + t.color.toString(16).padStart(6, "0") + ", hoisted", () => dc("PATCH", "/guilds/" + GUILD + "/roles/" + r.id, { color: t.color, hoist: true, mentionable: true }));
      else log("  = " + t.role + " already themed");
    }
    for (const e of EARNED) {
      const r = roles.find((x) => x.name === e.name);
      if (!r) await act("+ role " + e.name, () => dc("POST", "/guilds/" + GUILD + "/roles", { name: e.name, color: e.color, hoist: e.hoist, mentionable: false }));
      else if (r.position >= botRole.position) tooHigh.push(r.name);
      else if (r.color !== e.color || r.hoist !== e.hoist) await act("~ " + e.name, () => dc("PATCH", "/guilds/" + GUILD + "/roles/" + r.id, { color: e.color, hoist: e.hoist }));
      else log("  = " + e.name + " ok");
    }
    if (tooHigh.length) log("!! these roles sit above the bot's role, so it can't edit them — drag 'Crysterbaters Polls' above them in Server Settings → Roles and re-run:", tooHigh.join(", "));
    if (!DRY) {
      roles = await dc("GET", "/guilds/" + GUILD + "/roles");
      // order (top→bottom, all below the bot): Commissioner, Champion, teams, the rest
      const order = ["Commissioner", "🏆 Champion", ...TEAMS.map((t) => t.role), "🥄 Last Place", "🦈 Trade Shark", "💤 Forgot To Set A Lineup"]
        .map((n) => roles.find((r) => r.name === n)).filter((r) => r && r.position < botRole.position);
      let pos = botRole.position - 1;
      const payload = order.map((r) => ({ id: r.id, position: pos-- }));
      try { await dc("PATCH", "/guilds/" + GUILD + "/roles", payload); log("  ~ role order set"); } catch (e) { log("  ! role order:", e.message); }
      // commissioner + current champion to Sean
      try {
        const found = await dc("GET", "/guilds/" + GUILD + "/members/search?query=monkeydsean&limit=1");
        const sean = found && found[0];
        if (sean) for (const n of ["Commissioner", "🏆 Champion", "The JaleNBA"]) {
          const r = roles.find((x) => x.name === n); if (r && !sean.roles.includes(r.id)) { await dc("PUT", "/guilds/" + GUILD + "/members/" + sean.user.id + "/roles/" + r.id); log("  + " + n + " → monkeydsean"); }
        }
      } catch (e) { log("  ! member roles:", e.message); }
    }
  }

  // ---------- channels ----------
  let channels = await dc("GET", "/guilds/" + GUILD + "/channels");
  const byName = (n, type) => channels.find((c) => sameName(c.name, n) && (type == null || c.type === type));
  if (want("channels")) {
    log("\n== Channels ==");
    let catPos = 0;
    for (const block of LAYOUT) {
      let cat = channels.find((c) => c.type === 4 && sameName(c.name, block.category));
      if (!cat) cat = (await act("+ category " + block.category, () => dc("POST", "/guilds/" + GUILD + "/channels", { name: block.category, type: 4, position: catPos }))) || { id: "dry", position: catPos };
      else if (cat.position !== catPos) await act("~ move category " + block.category, () => dc("PATCH", "/channels/" + cat.id, { position: catPos }));
      catPos++;
      let pos = 0;
      for (const ch of block.channels) {
        const type = block.voice ? 2 : ch.forum ? 15 : 0;
        let c = channels.find((x) => x.type === type && (sameName(x.name, ch.name) || sameName(x.name, ch.was)));
        const overwrites = ch.readonly ? [
          { id: everyone.id, type: 0, deny: String(1n << 11n | 1n << 35n | 1n << 36n) },   // send, create public/private threads
          { id: botRole.id, type: 0, allow: String(1n << 11n | 1n << 13n | 1n << 29n) },     // send, manage messages, webhooks
        ] : undefined;
        if (!c) {
          const body = { name: ch.name, type, parent_id: cat ? cat.id : undefined, position: pos, topic: ch.topic, permission_overwrites: overwrites };
          if (ch.forum) Object.assign(body, {
            available_tags: [{ name: "Open", emoji_name: "🟢", moderated: false }, { name: "Done", emoji_name: "🤝", moderated: false }, { name: "Dead", emoji_name: "💀", moderated: false }, { name: "Keeper swap", emoji_name: "🔒", moderated: false }],
            default_reaction_emoji: { emoji_name: "👀" }, default_sort_order: 0,
          });
          c = await act("+ channel " + ch.name, async () => {
            try { return await dc("POST", "/guilds/" + GUILD + "/channels", body); }
            catch (e) { if (ch.forum) { log("  ! forum not available (" + e.message.slice(0, 120) + "), making a text channel"); return dc("POST", "/guilds/" + GUILD + "/channels", Object.assign(body, { type: 0, available_tags: undefined, default_reaction_emoji: undefined, default_sort_order: undefined })); } throw e; }
          });
          // forum replaces the old text #trade-block only if that one is empty
          if (ch.forum) {
            const old = channels.find((x) => x.type === 0 && sameName(x.name, ch.was));
            if (old) { const msgs = DRY ? [] : await dc("GET", "/channels/" + old.id + "/messages?limit=1"); if (!msgs.length) await act("- empty old #" + old.name, () => dc("DELETE", "/channels/" + old.id)); else log("  ! old #" + old.name + " has messages; left in place"); }
          }
        } else {
          const patch = {};
          if (c.name !== ch.name) patch.name = ch.name;
          if (cat && c.parent_id !== cat.id) patch.parent_id = cat.id;
          if (c.position !== pos) patch.position = pos;
          if (ch.topic && c.topic !== ch.topic) patch.topic = ch.topic;
          if (overwrites && !(c.permission_overwrites || []).some((o) => o.id === everyone.id && (BigInt(o.deny) & (1n << 11n)))) patch.permission_overwrites = overwrites;
          if (Object.keys(patch).length) await act("~ " + c.name + " → " + JSON.stringify(patch), () => dc("PATCH", "/channels/" + c.id, patch));
          else log("  = " + c.name + " ok");
        }
        pos++;
      }
    }
    if (!DRY) channels = await dc("GET", "/guilds/" + GUILD + "/channels");
    for (const old of ["Text Channels", "Voice Channels"]) {
      const cat = channels.find((c) => c.type === 4 && c.name === old);
      if (cat && !channels.some((c) => c.parent_id === cat.id)) await act("- empty category " + old, () => dc("DELETE", "/channels/" + cat.id));
    }
  }

  // ---------- hall of fame ----------
  if (want("hof")) {
    log("\n== Hall of Fame ==");
    const hof = byName("hall-of-fame", 0);
    if (!hof) log("  ! no #hall-of-fame channel yet (run channels first)");
    else {
      const emo = DRY ? [] : await dc("GET", "/guilds/" + GUILD + "/emojis");
      const history = JSON.parse(fs.readFileSync(path.join(__dirname, "league-history.json"), "utf8"));
      const byMgr = (m) => TEAMS.find((t) => t.mgr === m);
      const tag = (t) => { const e = t && emo.find((x) => x.name === t.emoji); return e ? "<:" + e.name + ":" + e.id + "> " : ""; };
      const lines = history.filter((h) => h.champ).map((h) => {
        const t = byMgr(h.champ);
        return "**" + h.year + "** · " + tag(t) + "**" + h.champ + "**" + (h.team ? " — " + h.team : "") + (h.runnerUp ? "  ·  2nd: " + h.runnerUp : "") + (h.third ? "  ·  3rd: " + h.third : "") + (h.note ? " _(" + h.note + ")_" : "");
      });
      const ringCount = {};
      history.forEach((h) => { if (h.champ) ringCount[h.champ] = (ringCount[h.champ] || 0) + 1; });
      const counts = Object.entries(ringCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([m, n]) => { const t = byMgr(m); return "🏆".repeat(n) + " " + (t ? tag(t) + t.role + " (" + m + ")" : m) + " — " + n; });
      const never = TEAMS.filter((t) => !ringCount[t.mgr]).map((t) => t.role);
      const eras = []; history.slice().reverse().forEach((h) => { const last = eras[eras.length - 1]; if (last && last.league === h.league) last.to = h.year; else eras.push({ league: h.league, from: h.year, to: h.year }); });
      const parts = [
        "# 🏆 Crysterbaters Hall of Fame\n\n" + lines.join("\n"),
        "**Ring count**\n" + counts.join("\n") +
          (never.length ? "\n\nStill chasing the first one: " + never.join(", ") + "." : "") +
          "\n\n**The league has been called**\n" + eras.map((e) => "· " + e.league + " (" + (e.from === e.to ? e.from : e.from + "–" + e.to) + ")").join("\n") +
          "\n\nESPN 2012–18, Yahoo since 2019. 2012 was never recorded. Full history, draft boards and keeper math: <" + SITE + ">",
      ];
      const existing = DRY ? [] : await dc("GET", "/channels/" + hof.id + "/messages?limit=20");
      const mine = existing.filter((m) => m.author && m.author.id === APP_ID).reverse();
      if (mine.length === parts.length && mine.every((m, i) => m.content === parts[i])) log("  = Hall of Fame posts current");
      else {
        for (const m of mine) await dc("DELETE", "/channels/" + hof.id + "/messages/" + m.id).catch(() => {});
        let first = null;
        for (const content of parts) {
          if (content.length > 2000) log("  ! a part is " + content.length + " chars (limit 2000)");
          const msg = await act("+ post Hall of Fame (" + content.length + " chars)", () => dc("POST", "/channels/" + hof.id + "/messages", { content }));
          if (msg && !first) first = msg;
        }
        if (first) { try { await dc("PUT", "/channels/" + hof.id + "/messages/pins/" + first.id); } catch (_) { try { await dc("PUT", "/channels/" + hof.id + "/pins/" + first.id); } catch (e) { log("  ! pin:", e.message); } } }
      }
    }
  }

  // ---------- site-updates webhook ----------
  if (want("webhook")) {
    log("\n== #site-updates webhook ==");
    const ch = byName("site-updates", 0);
    if (!ch) log("  ! no #site-updates channel yet");
    else if (/SITE_UPDATES_WEBHOOK=/.test(fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "")) log("  = webhook already saved in .env");
    else {
      const hooks = await dc("GET", "/channels/" + ch.id + "/webhooks");
      let hook = hooks.find((h) => h.name === "Site updates" && h.token);
      if (!hook) hook = await act("+ webhook 'Site updates'", () => dc("POST", "/channels/" + ch.id + "/webhooks", { name: "Site updates" }));
      if (hook && hook.token) {
        const url = "https://discord.com/api/webhooks/" + hook.id + "/" + hook.token;
        fs.appendFileSync(ENV_FILE, "\nSITE_UPDATES_WEBHOOK=" + url + "\n");
        log("  + webhook URL saved to .env as SITE_UPDATES_WEBHOOK (paste it into Vercel → Settings → Webhooks? No: Vercel's Discord integration, and GitHub → Settings → Webhooks with '/github' appended)");
      }
    }
  }

  log("\n" + (DRY ? "Dry run complete. Re-run without --dry to apply." : "Done."));
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
