// Renders a poll as a Discord message and keeps the mirror up to date.
"use strict";

const supa = require("./supa");
const dc = require("./discord");

const SITE = "https://crysterbaters.com/#polls";
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "🅰️", "🅱️"];
const BAR = 12;

const channelId = () => process.env.DISCORD_POLLS_CHANNEL_ID || "";

function bar(n, total) {
  const filled = total ? Math.round((n / total) * BAR) : 0;
  return "█".repeat(filled) + "░".repeat(BAR - filled);
}

function trunc(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Who is allowed to be named next to their vote right now.
function namesVisible(poll) {
  if (poll.visibility === "named") return true;
  if (poll.visibility === "anon_until_close") return !supa.pollIsOpen(poll);
  return false;
}

function buildMessage(poll, votes, profiles) {
  const open = supa.pollIsOpen(poll);
  const byUser = new Map(profiles.map((p) => [p.user_id, p]));
  const creator = byUser.get(poll.created_by) || null;
  const total = votes.length;
  const showNames = namesVisible(poll);

  const vis =
    poll.visibility === "named" ? "named votes"
    : poll.visibility === "anon" ? "anonymous"
    : open ? "anonymous until it closes" : "names revealed at close";

  let status;
  if (poll.closed) status = "**Closed**";
  else if (poll.closes_at && !open) status = "**Closed** " + dc.ts(poll.closes_at, "D");
  else if (poll.closes_at) status = "closes " + dc.ts(poll.closes_at, "R");
  else status = "open until closed";

  const lines = [];
  lines.push("📊 **" + poll.question + "**");
  lines.push("-# Asked by " + supa.nameFor(creator, poll.created_by_email) + " · " + vis + " · " + status);
  lines.push("");
  poll.options.forEach((opt, i) => {
    const vs = votes.filter((v) => v.option_index === i);
    let line = (KEYCAPS[i] || (i + 1) + ".") + " **" + opt + "** — " + vs.length + "  `" + bar(vs.length, total) + "`";
    if (showNames && vs.length) {
      line += "  " + vs.map((v) => supa.nameFor(byUser.get(v.user_id), v.voter_email)).join(", ");
    }
    lines.push(line);
  });
  lines.push("");
  const members = profiles.length || 10;
  lines.push("-# " + total + " of " + members + " voted · also on the site: <" + SITE + ">");

  // Buttons: one per option (5 per row), then a control row.
  const rows = [];
  for (let i = 0; i < poll.options.length; i += 5) {
    rows.push({
      type: 1,
      components: poll.options.slice(i, i + 5).map((opt, j) => ({
        type: 2,
        style: 2,
        label: trunc((i + j + 1) + " · " + opt, 80),
        custom_id: "vote:" + poll.id + ":" + (i + j),
        disabled: !open,
      })),
    });
  }
  const control = [{ type: 2, style: 5, label: "Open on the site", url: SITE }];
  if (open) control.unshift({ type: 2, style: 4, label: "Close poll", custom_id: "close:" + poll.id });
  rows.push({ type: 1, components: control });

  return { content: lines.join("\n"), components: rows, allowed_mentions: { parse: [] } };
}

async function loadAll(pollId) {
  const [poll, votes, profiles] = await Promise.all([supa.getPoll(pollId), supa.getVotes(pollId), supa.profiles()]);
  return { poll, votes, profiles };
}

// Post the poll to #polls if it isn't there yet, otherwise edit in place.
// Returns the rendered payload so an interaction can reuse it.
async function sync(pollId) {
  const { poll, votes, profiles } = await loadAll(pollId);
  if (!poll) {
    // Deleted on the site: remove the mirror if we still have one.
    const m = await supa.getMessage(pollId);
    if (m) {
      try { await dc.deleteMessage(m.channel_id, m.message_id); } catch (e) { if (e.status !== 404) throw e; }
      await supa.remove("poll_messages", "poll_id=eq." + pollId);
    }
    return null;
  }
  const payload = buildMessage(poll, votes, profiles);
  const existing = await supa.getMessage(pollId);
  if (existing) {
    try {
      await dc.editMessage(existing.channel_id, existing.message_id, payload);
    } catch (e) {
      if (e.status !== 404) throw e;
      // Someone deleted the Discord message by hand; repost.
      await supa.remove("poll_messages", "poll_id=eq." + pollId);
      return sync(pollId);
    }
    if (!supa.pollIsOpen(poll) && !existing.closed_rendered) {
      await supa.update("poll_messages", "poll_id=eq." + pollId, { closed_rendered: true });
    }
    return payload;
  }
  if (!channelId()) throw new Error("DISCORD_POLLS_CHANNEL_ID is not set");
  const msg = await dc.postMessage(channelId(), payload);
  await supa.upsert("poll_messages", {
    poll_id: pollId, channel_id: channelId(), message_id: msg.id, closed_rendered: !supa.pollIsOpen(poll),
  }, "poll_id");
  return payload;
}

// Polls that closed by the clock since their last render.
async function sweep() {
  const rows = await supa.select("poll_messages", "select=poll_id&closed_rendered=is.false");
  let n = 0;
  for (const r of rows) {
    const p = await supa.getPoll(r.poll_id);
    if (p && !supa.pollIsOpen(p)) { await sync(r.poll_id); n++; }
  }
  return n;
}

module.exports = { buildMessage, sync, sweep, SITE };
