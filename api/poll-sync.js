// Receives change notifications from Postgres (public.discord_notify via
// pg_net) and mirrors the poll into Discord. Also serves the daily sweep
// (Vercel cron) that marks clock-closed polls as closed in Discord.
//
// Body: { type: INSERT|UPDATE|DELETE, table: polls|votes, record, old_record }
// Auth: header x-cb-secret must equal SYNC_SECRET (or ?key= for the cron).
"use strict";

const poll = require("./_lib/poll");

function timingSafeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

module.exports = async (req, res) => {
  const secret = process.env.SYNC_SECRET || "";
  const given = req.headers["x-cb-secret"] || (req.query && req.query.key) || "";
  const isCron = !!req.headers["x-vercel-cron"];
  if (!secret || (!isCron && !timingSafeEqual(given, secret))) return res.status(401).send("nope");

  try {
    if (req.method === "GET") {
      const n = await poll.sweep();
      return res.status(200).json({ swept: n });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const rec = body.record || body.old_record || {};
    const pollId = body.table === "votes" ? rec.poll_id : rec.id;
    if (!pollId) return res.status(400).json({ error: "no poll id in payload" });
    await poll.sync(pollId);
    return res.status(200).json({ ok: true, poll: pollId, event: body.type, table: body.table });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
