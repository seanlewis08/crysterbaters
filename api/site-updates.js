// Receives change notifications from Postgres (public.site_notify via pg_net)
// and announces the ones worth announcing in #site-updates through the
// channel's webhook (SITE_UPDATES_WEBHOOK). Formatting lives in
// _lib/site-events.js; this file is auth + plumbing.
//
// Body: { type: INSERT|UPDATE|DELETE, table, record, old_record }
// Auth: header x-cb-secret must equal SYNC_SECRET.
"use strict";

const supa = require("./_lib/supa");
const events = require("./_lib/site-events");

function timingSafeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const profileByUser = (userId) => supa.one("profiles", "select=*&user_id=eq." + encodeURIComponent(userId));

async function post(hook, payload) {
  const r = await fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://crysterbaters.com, 1.0)" },
    body: JSON.stringify(Object.assign({ username: "Crysterbaters", allowed_mentions: { parse: [] } }, payload)),
  });
  if (!r.ok) throw new Error("webhook " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

module.exports = async (req, res) => {
  const secret = process.env.SYNC_SECRET || "";
  const given = req.headers["x-cb-secret"] || "";
  if (!secret || !timingSafeEqual(given, secret)) return res.status(401).send("nope");
  if (req.method !== "POST") return res.status(405).send("POST only");
  const hook = process.env.SITE_UPDATES_WEBHOOK;
  if (!hook) return res.status(200).json({ skipped: "SITE_UPDATES_WEBHOOK not set" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const ev = await events.describe(body, { profileByUser, getVotes: supa.getVotes, pollsChannel: process.env.DISCORD_POLLS_CHANNEL_ID });
    if (!ev) return res.status(200).json({ skipped: "not announced" });
    const msg = await post(hook, { embeds: [ev.embed], content: ev.content });
    return res.status(200).json({ posted: msg.id, title: ev.embed.title });
  } catch (e) {
    console.error("site-updates:", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};

module.exports._test = { post };
