// Dues in Discord: /dues shows your own status with pay links and an
// "I've paid" button; a pinned board in #dues shows everyone; the
// commissioner confirms payments and can ping whoever still owes. Same
// tables as the site's Dues page (dues_seasons, dues_payments), so the two
// never disagree. Amounts and handles come from the active season row.
"use strict";

const supa = require("./supa");
const dc = require("./discord");

const GUILD = () => process.env.DISCORD_GUILD_ID || "1561010642561794068";
const SITE = "https://crysterbaters.com";
const BOARD_TAG = "# 💸 Dues board";
const NUDGE_TAG = "⏰ **Dues reminder**";

// ---------- data ----------
async function activeSeason() {
  const rows = await supa.select("dues_seasons", "select=*&active=eq.true&order=created_at.desc&limit=1");
  return rows[0] || null;
}
const payments = (season) => supa.select("dues_payments", "select=*&season=eq." + encodeURIComponent(season));
const paymentFor = (rows, teamId) => rows.find((r) => r.team_id === teamId) || null;

const money = (n) => "$" + (Number(n) % 1 === 0 ? Number(n).toFixed(0) : Number(n).toFixed(2));
const dueText = (s) => s.due_date ? " · due <t:" + Math.floor(new Date(s.due_date + "T20:00:00Z") / 1000) + ":D>" : "";
const state = (p) => (p && p.confirmed ? "confirmed" : p && p.paid ? "paid" : "unpaid");
const ICON = { confirmed: "✅", paid: "🟡", unpaid: "❌" };

// ---------- pay links ----------
function payLinks(season, teamName) {
  const amt = Number(season.amount) || 0;
  const note = encodeURIComponent("Crysterbaters " + season.season + " – " + teamName);
  const out = [];
  if (season.venmo) out.push({ type: 2, style: 5, label: "Venmo", emoji: { name: "💙" }, url: "https://venmo.com/" + encodeURIComponent(String(season.venmo).replace(/^@/, "")) + "?txn=pay&amount=" + amt + "&note=" + note });
  if (season.cashapp) out.push({ type: 2, style: 5, label: "Cash App", emoji: { name: "💚" }, url: "https://cash.app/$" + encodeURIComponent(String(season.cashapp).replace(/^\$/, "")) + "/" + amt });
  if (season.zelle) out.push({ type: 2, style: 2, custom_id: "dues:zelle", label: "Zelle", emoji: { name: "💜" } });
  return out;
}

// ---------- the private status card (/dues or "Pay now") ----------
function statusCard(season, team, p, isCommish) {
  const st = state(p);
  const lines = [
    "**" + season.season + " dues: " + money(season.amount) + "**" + dueText(season),
    "You (" + team.name + "): " + ICON[st] + " " + (st === "confirmed" ? "paid and confirmed. Thanks." : st === "paid" ? "marked paid" + (p.method ? " via " + cap(p.method) : "") + ", waiting on the commissioner." : "**unpaid**."),
  ];
  if (season.note) lines.push("_" + season.note + "_");
  const rows = [];
  const links = payLinks(season, team.name);
  if (st === "unpaid") {
    if (links.length) rows.push({ type: 1, components: links });
    rows.push({ type: 1, components: [
      { type: 2, style: 3, custom_id: "dues:paid:" + season.season, label: "I've paid", emoji: { name: "💸" } },
      { type: 2, style: 5, label: "Dues page", url: SITE + "/#dues" },
    ] });
  } else {
    rows.push({ type: 1, components: [{ type: 2, style: 5, label: "Dues page", url: SITE + "/#dues" }] });
  }
  if (isCommish) rows.push({ type: 1, components: [
    { type: 2, style: 1, custom_id: "dues:board", label: "Refresh board", emoji: { name: "📋" } },
    { type: 2, style: 4, custom_id: "dues:remind", label: "Remind the unpaid", emoji: { name: "📣" } },
  ] });
  return { content: lines.join("\n"), components: rows, flags: dc.EPHEMERAL, allowed_mentions: { parse: [] } };
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// ---------- the public board ----------
function boardMessage(season, rows, profiles) {
  const byTeam = {};
  profiles.forEach((pr) => { byTeam[pr.team_id] = pr; });
  const lines = supa.TEAMS.map((t) => {
    const p = paymentFor(rows, t.id);
    const st = state(p);
    const who = byTeam[t.id] && byTeam[t.id].discord_id ? "<@" + byTeam[t.id].discord_id + ">" : t.short;
    return ICON[st] + " " + t.name + " — " + who + (st === "paid" ? " _(awaiting confirmation" + (p.method ? ", " + cap(p.method) : "") + ")_" : "");
  });
  const paid = rows.filter((r) => r.paid).length, confirmed = rows.filter((r) => r.confirmed).length;
  return {
    content: [
      BOARD_TAG,
      "**" + season.season + " · " + money(season.amount) + " per team" + dueText(season) + "**",
      "",
      ...lines,
      "",
      confirmed + "/" + supa.TEAMS.length + " confirmed · " + paid + " paid" + (season.note ? "\n_" + season.note + "_" : ""),
      "-# Tap **Pay now** for your own links. ✅ confirmed · 🟡 paid, awaiting Sean · ❌ unpaid",
    ].join("\n"),
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [
      { type: 2, style: 3, custom_id: "dues:me", label: "Pay now", emoji: { name: "💸" } },
      { type: 2, style: 5, label: "Dues page", url: SITE + "/#dues" },
    ] }],
  };
}

async function duesChannel() {
  if (process.env.DISCORD_DUES_CHANNEL_ID) return process.env.DISCORD_DUES_CHANNEL_ID;
  const chans = await dc.api("GET", "/guilds/" + GUILD() + "/channels");
  const c = chans.find((x) => x.type === 0 && /dues/i.test(x.name));
  return c ? c.id : null;
}

async function findBoard(channelId) {
  const msgs = await dc.api("GET", "/channels/" + channelId + "/messages?limit=50");
  return msgs.find((m) => m.author && m.author.bot && (m.content || "").startsWith(BOARD_TAG)) || null;
}

// Re-render the board (create it if missing). Returns the message or null when there is no #dues channel / season.
async function refreshBoard() {
  const season = await activeSeason();
  const channelId = await duesChannel();
  if (!season || !channelId) return null;
  const [rows, profiles] = await Promise.all([payments(season.season), supa.profiles()]);
  const body = boardMessage(season, rows, profiles);
  const existing = await findBoard(channelId);
  if (existing) return dc.api("PATCH", "/channels/" + channelId + "/messages/" + existing.id, body);
  return dc.api("POST", "/channels/" + channelId + "/messages", body);
}

// Ping whoever still owes. Linked managers get a real mention; the rest are named.
async function remind(season, rows, profiles, { auto = false } = {}) {
  const channelId = await duesChannel();
  if (!channelId) return null;
  const owing = supa.TEAMS.filter((t) => !(paymentFor(rows, t.id) || {}).paid);
  if (!owing.length) return dc.api("POST", "/channels/" + channelId + "/messages", { content: "🎉 Everyone has paid " + season.season + " dues. Commissioner's dream.", allowed_mentions: { parse: [] } });
  const byTeam = {}; profiles.forEach((pr) => { byTeam[pr.team_id] = pr; });
  const mentions = owing.map((t) => (byTeam[t.id] && byTeam[t.id].discord_id ? "<@" + byTeam[t.id].discord_id + ">" : t.short));
  const ids = owing.map((t) => byTeam[t.id] && byTeam[t.id].discord_id).filter(Boolean);
  const content = NUDGE_TAG + (auto ? " (automatic)" : "") + "\n" + mentions.join(" ") + " — " + money(season.amount) + " for " + season.season + dueText(season) + ". Tap **Pay now** on the board above or run `/dues`.";
  return dc.api("POST", "/channels/" + channelId + "/messages", { content, allowed_mentions: { users: ids } });
}

// Daily (from the poll-sync cron): nudge 3 days before the due date, on it, and weekly after, once per day.
async function autoNudge(now = new Date()) {
  const season = await activeSeason();
  if (!season || !season.due_date) return { skipped: "no due date" };
  const channelId = await duesChannel();
  if (!channelId) return { skipped: "no #dues channel" };
  const due = new Date(season.due_date + "T12:00:00Z");
  const days = Math.round((due - now) / 86400000);           // positive = days until due
  const fire = days === 3 || days === 0 || (days < 0 && (-days) % 7 === 0);
  if (!fire) return { skipped: "not a nudge day", days };
  const msgs = await dc.api("GET", "/channels/" + channelId + "/messages?limit=20");
  const today = now.toISOString().slice(0, 10);
  if (msgs.some((m) => (m.content || "").startsWith(NUDGE_TAG) && m.timestamp.slice(0, 10) === today)) return { skipped: "already nudged today" };
  const [rows, profiles] = await Promise.all([payments(season.season), supa.profiles()]);
  if (supa.TEAMS.every((t) => (paymentFor(rows, t.id) || {}).paid)) return { skipped: "all paid" };
  await remind(season, rows, profiles, { auto: true });
  return { nudged: true, days };
}

// ---------- interactions ----------
const ephemeral = (content) => ({ type: dc.RT.CHANNEL_MESSAGE, data: { content, flags: dc.EPHEMERAL, allowed_mentions: { parse: [] } } });

async function myCard(me) {
  const season = await activeSeason();
  if (!season) return ephemeral("No dues season is open right now.");
  const team = supa.teamById(me.team_id);
  const rows = await payments(season.season);
  return { type: dc.RT.CHANNEL_MESSAGE, data: statusCard(season, team, paymentFor(rows, me.team_id), await supa.isCommissioner(me)) };
}

async function handleCommand(ix, me) {
  if (!me) return ephemeral("Run **/link** and pick your team first, then `/dues` knows whose dues to show.");
  return myCard(me);
}

async function handleComponent(ix, me) {
  const id = String(ix.data.custom_id || "");
  const parts = id.split(":");
  if (!me) return ephemeral("Run **/link** and pick your team first.");

  if (id === "dues:me") return myCard(me);

  if (id === "dues:zelle") {
    const season = await activeSeason();
    if (!season || !season.zelle) return ephemeral("No Zelle contact is set up. Ask Sean.");
    return ephemeral("💜 **Zelle:** send " + money(season.amount) + " to `" + season.zelle + "` with the note _Crysterbaters " + season.season + " – " + supa.teamById(me.team_id).name + "_, then come back and tap **I've paid**.");
  }

  if (parts[0] === "dues" && parts[1] === "paid") {
    // step 1: ask how; step 2 (dues:paid:<season>:<method>) record it
    const seasonId = parts[2];
    if (!parts[3]) {
      return { type: dc.RT.UPDATE_MESSAGE, data: { content: "How did you pay " + seasonId + " dues?", components: [{ type: 1, components: [
        { type: 2, style: 2, custom_id: "dues:paid:" + seasonId + ":venmo", label: "Venmo", emoji: { name: "💙" } },
        { type: 2, style: 2, custom_id: "dues:paid:" + seasonId + ":cashapp", label: "Cash App", emoji: { name: "💚" } },
        { type: 2, style: 2, custom_id: "dues:paid:" + seasonId + ":zelle", label: "Zelle", emoji: { name: "💜" } },
        { type: 2, style: 2, custom_id: "dues:paid:" + seasonId + ":cash", label: "Cash / other", emoji: { name: "💵" } },
      ] }] } };
    }
    const method = parts[3] === "other" ? "other" : parts[3];
    const season = await activeSeason();
    if (!season || season.season !== seasonId) return ephemeral("That dues season isn't open any more.");
    const existing = paymentFor(await payments(seasonId), me.team_id);
    if (existing && existing.confirmed) return { type: dc.RT.UPDATE_MESSAGE, data: { content: "✅ Already confirmed. You're good.", components: [] } };
    const now = new Date().toISOString();
    await supa.upsert("dues_payments", { season: seasonId, team_id: me.team_id, user_id: me.user_id, method, paid: true, paid_at: (existing && existing.paid_at) || now, updated_at: now, confirmed: false }, "season,team_id");
    try { await refreshBoard(); } catch (e) { console.error("board refresh:", e.message); }
    // public line with a commissioner-only Confirm button
    try {
      const channelId = await duesChannel();
      if (channelId) await dc.api("POST", "/channels/" + channelId + "/messages", {
        content: "🟡 **" + supa.teamById(me.team_id).name + "** marked " + seasonId + " dues paid via " + cap(method) + ".",
        allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: "dues:confirm:" + seasonId + ":" + me.team_id, label: "Confirm received (Sean)", emoji: { name: "✅" } }] }],
      });
    } catch (e) { console.error("paid notice:", e.message); }
    return { type: dc.RT.UPDATE_MESSAGE, data: { content: "💸 Marked paid via " + cap(method) + ". It turns ✅ once Sean confirms the money landed. Thanks!", components: [] } };
  }

  if (parts[0] === "dues" && parts[1] === "confirm") {
    if (!(await supa.isCommissioner(me))) return ephemeral("Only the commissioner can confirm payments.");
    const [, , seasonId, teamId] = parts;
    const now = new Date().toISOString();
    const existing = paymentFor(await payments(seasonId), teamId);
    await supa.upsert("dues_payments", Object.assign({ season: seasonId, team_id: teamId }, existing || {}, { paid: true, paid_at: (existing && existing.paid_at) || now, confirmed: true, confirmed_at: now, updated_at: now }), "season,team_id");
    try { await refreshBoard(); } catch (e) { console.error("board refresh:", e.message); }
    return { type: dc.RT.UPDATE_MESSAGE, data: { content: "✅ **" + supa.teamById(teamId).name + "** — " + seasonId + " dues confirmed.", components: [] } };
  }

  if (id === "dues:board") {
    if (!(await supa.isCommissioner(me))) return ephemeral("Commissioner only.");
    const m = await refreshBoard();
    return ephemeral(m ? "Board refreshed." : "No #dues channel or no active season.");
  }

  if (id === "dues:remind") {
    if (!(await supa.isCommissioner(me))) return ephemeral("Commissioner only.");
    const season = await activeSeason();
    if (!season) return ephemeral("No active dues season.");
    const [rows, profiles] = await Promise.all([payments(season.season), supa.profiles()]);
    await remind(season, rows, profiles);
    return ephemeral("Reminder posted.");
  }
  return null;
}

module.exports = { activeSeason, payments, payLinks, statusCard, boardMessage, refreshBoard, remind, autoNudge, handleCommand, handleComponent, BOARD_TAG, NUDGE_TAG };
