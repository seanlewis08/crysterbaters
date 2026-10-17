// Turns a Postgres change notification into a #site-updates embed, or null
// when the change isn't worth announcing. Pure: no I/O except the few
// lookups passed in through `ctx` so it can be unit-tested with fakes.
//
//   const ev = await describe({ type, table, record, old_record }, ctx)
//   ev → { embed, content? } | null
"use strict";

const supa = require("./supa");
const SITE = "https://crysterbaters.com";

const COLORS = { poll: 0x2f63b5, dues: 0x3c8f4a, badge: 0xb48c18, keeper: 0x1b3f7a, agenda: 0xb03f82, issue: 0x1e9ab0, chart: 0xc1571a, deploy: 0x546e7a };

// Badge names from the site's catalogue (index.html CAT); ids not listed fall back to a title-cased slug.
const BADGES = {
  "the-belt": "The Belt", "grandfather-clause": "Grandfather Clause", "regular-season-giannis": "Regular Season Giannis",
  "trader-joe": "Trader Joe", "the-hoarder": "The Hoarder", "all-gas": "All Gas", "mr-irrelevant": "Mr. Irrelevant",
  "sunk-cost": "Sunk Cost", "free-throw-king": "Free Throw King", "the-reach": "The Reach", "the-steal": "The Steal",
  "homer": "Homer", "nursery": "Nursery", "the-sweep": "The Sweep", "the-upset": "The Upset", "waffle-house": "Waffle House",
};
const badgeName = (id) => BADGES[id] || String(id || "").split("-").map((w) => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(" ");

const team = (id) => supa.teamById(id);
const teamLabel = (id) => { const t = team(id); return t ? t.name + " (" + t.short + ")" : id; };
const trunc = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
const link = (hash) => SITE + "/#" + hash;
const changed = (n, o, k) => !o || n[k] !== o[k];

function embed(color, title, description, url, footer) {
  const e = { color, title: trunc(title, 256), url, timestamp: new Date().toISOString() };
  if (description) e.description = trunc(description, 1500);
  if (footer) e.footer = { text: footer };
  return e;
}

async function whoBy(rec, ctx) {
  // Prefer the profile's display name, then the team short name, then the email's local part.
  const email = rec.created_by_email || "";
  const prof = rec.created_by && ctx.profileByUser ? await ctx.profileByUser(rec.created_by) : null;
  return supa.nameFor(prof, email);
}

async function describe(n, ctx = {}) {
  const { type, table, record: r, old_record: o } = n;
  if (!r && type !== "DELETE") return null;

  switch (table) {
    case "polls": {
      if (type === "INSERT") {
        const by = await whoBy(r, ctx);
        const opts = (r.options || []).map((x, i) => String.fromCodePoint(0x1f1e6 + i) + " " + x).join("\n");
        const closes = r.closes_at ? "\nCloses <t:" + Math.floor(new Date(r.closes_at) / 1000) + ":R>." : "";
        return { embed: embed(COLORS.poll, "🗳️ New poll: " + r.question, opts + closes + "\nVote on the site or in <#" + (ctx.pollsChannel || "") + ">.", link("polls"), "Opened by " + by) };
      }
      if (type === "UPDATE" && r.closed && o && !o.closed) {
        const votes = ctx.getVotes ? await ctx.getVotes(r.id) : [];
        const counts = (r.options || []).map((label, i) => ({ label, n: votes.filter((v) => v.option_index === i).length }));
        const max = Math.max(0, ...counts.map((c) => c.n));
        const winners = counts.filter((c) => c.n === max && max > 0).map((c) => c.label);
        const lines = counts.sort((a, b) => b.n - a.n).map((c) => (c.n === max && max > 0 ? "**" : "") + c.label + (c.n === max && max > 0 ? "**" : "") + " — " + c.n).join("\n");
        const verdict = !max ? "No votes were cast." : winners.length > 1 ? "Tie: " + winners.join(" / ") : "Result: **" + winners[0] + "**";
        return { embed: embed(COLORS.poll, "🔒 Poll closed: " + r.question, verdict + "\n\n" + lines, link("pollhist"), votes.length + " vote" + (votes.length === 1 ? "" : "s")) };
      }
      return null;
    }
    case "dues_payments": {
      if (type === "DELETE") return null;
      if (r.paid && (!o || !o.paid)) {
        const how = r.method && r.method !== "other" ? " via " + r.method[0].toUpperCase() + r.method.slice(1) : "";
        return { embed: embed(COLORS.dues, "💸 Dues paid: " + teamLabel(r.team_id), r.season + " dues marked paid" + how + ".", link("dues"), r.confirmed ? "Confirmed by the commissioner" : "Awaiting commissioner confirmation") };
      }
      if (r.confirmed && o && !o.confirmed && r.paid) {
        return { embed: embed(COLORS.dues, "✅ Dues confirmed: " + teamLabel(r.team_id), r.season + " payment confirmed.", link("dues")) };
      }
      return null;
    }
    case "badge_awards": {
      if (type !== "INSERT") return null;
      return { embed: embed(COLORS.badge, "🏅 Badge awarded: " + badgeName(r.badge_id), "**" + teamLabel(r.team_id) + "** · " + r.season + (r.note ? " · " + r.note : ""), link("badges")) };
    }
    case "keeper_requests": {
      if (type === "INSERT") {
        return { embed: embed(COLORS.keeper, "🔒 Keeper request: " + r.player + (r.nba_team ? " (" + r.nba_team + ")" : ""), "**" + teamLabel(r.team_id) + "** asked to keep " + r.player + " for " + r.season + "." + (r.note ? "\n> " + trunc(r.note, 300) : ""), link("keepers"), "Pending commissioner review") };
      }
      if (type === "UPDATE" && changed(r, o, "status") && r.status !== "pending") {
        const ok = r.status === "approved";
        return { embed: embed(COLORS.keeper, (ok ? "✅ Keeper approved: " : "❌ Keeper declined: ") + r.player, "**" + teamLabel(r.team_id) + "** · " + r.season + (r.reply ? "\n> " + trunc(r.reply, 300) : ""), link("keepers")) };
      }
      return null;
    }
    case "agenda": {
      if (type === "INSERT") {
        const by = await whoBy(r, ctx);
        return { embed: embed(COLORS.agenda, "📌 New open item: " + r.title, r.details ? trunc(r.details, 400) : "", link("agenda"), "Raised by " + by) };
      }
      if (type === "UPDATE" && changed(r, o, "status") && r.status === "decided") {
        return { embed: embed(COLORS.agenda, "⚖️ Decided: " + r.title, r.outcome ? trunc(r.outcome, 600) : "", link("agenda")) };
      }
      return null;
    }
    case "issues": {
      if (type === "INSERT") {
        const by = await whoBy(r, ctx);
        const kind = { bug: "🐛 Bug", idea: "💡 Idea", question: "❓ Question", other: "📝 Note" }[r.kind] || "📝";
        return { embed: embed(COLORS.issue, kind + " #" + r.num + ": " + r.title, r.body ? trunc(r.body, 400) : "", link("issues"), "Filed by " + by) };
      }
      if (type === "UPDATE" && changed(r, o, "status") && r.status === "closed") {
        return { embed: embed(COLORS.issue, "✔️ Closed #" + r.num + ": " + r.title, "", link("issues")) };
      }
      return null;
    }
    case "charts": {
      if (type === "UPDATE" && r.pinned && o && !o.pinned) {
        return { embed: embed(COLORS.chart, "📈 Chart of the week: " + r.title, r.author ? "Pinned · by " + r.author : "Pinned", link("plot")) };
      }
      return null;
    }
    default:
      return null;
  }
}

// Post one event to the #site-updates webhook (SITE_UPDATES_WEBHOOK). Returns
// { posted, title } or { skipped }. Lookups come from supa so poll results
// can count votes and "Opened by" can use display names.
async function announce(body) {
  const hook = process.env.SITE_UPDATES_WEBHOOK;
  if (!hook) return { skipped: "SITE_UPDATES_WEBHOOK not set" };
  const profileByUser = (userId) => supa.one("profiles", "select=*&user_id=eq." + encodeURIComponent(userId));
  const ev = await describe(body, { profileByUser, getVotes: supa.getVotes, pollsChannel: process.env.DISCORD_POLLS_CHANNEL_ID });
  if (!ev) return { skipped: "not announced" };
  const r = await fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://crysterbaters.com, 1.0)" },
    body: JSON.stringify({ username: "Crysterbaters", allowed_mentions: { parse: [] }, embeds: [ev.embed], content: ev.content }),
  });
  if (!r.ok) throw new Error("site-updates webhook " + r.status + " " + (await r.text()).slice(0, 200));
  const msg = await r.json();
  return { posted: msg.id, title: ev.embed.title };
}

module.exports = { describe, announce, badgeName, COLORS, SITE };
