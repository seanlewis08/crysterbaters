// Receives change notifications from Postgres via pg_net and does two things:
//   polls / votes  → mirrors the poll into #polls (public.discord_notify)
//   polls + dues_payments, badge_awards, keeper_requests, agenda, issues, charts
//                  → announces the noteworthy ones in #site-updates (public.site_notify;
//                    formatting in _lib/site-events.js)
// Also serves the daily sweep (Vercel cron) that marks clock-closed polls as
// closed in Discord. One function for all of it: the Hobby plan allows 12.
//
// Body: { type: INSERT|UPDATE|DELETE, table, record, old_record }
// Auth: header x-cb-secret must equal SYNC_SECRET (or ?key= for the cron).
"use strict";

const poll = require("./_lib/poll");
const events = require("./_lib/site-events");
const dues = require("./_lib/dues");

const POLL_TABLES = new Set(["polls", "votes"]);

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
      let nudge = null;
      try { nudge = await dues.autoNudge(); } catch (e) { console.error("dues nudge:", e); nudge = { error: e.message }; }
      return res.status(200).json({ swept: n, dues: nudge });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const out = { ok: true, event: body.type, table: body.table };
    if (POLL_TABLES.has(body.table)) {
      const rec = body.record || body.old_record || {};
      const pollId = body.table === "votes" ? rec.poll_id : rec.id;
      if (!pollId) return res.status(400).json({ error: "no poll id in payload" });
      await poll.sync(pollId);
      out.poll = pollId;
    }
    if (body.table !== "votes") {
      try { out.site = await events.announce(body); }
      catch (e) { console.error("site-updates:", e); out.site = { error: e.message || String(e) }; }
    }
    if (body.table === "dues_payments" || body.table === "dues_seasons") {
      try { out.board = !!(await dues.refreshBoard()); } catch (e) { console.error("dues board:", e); out.board = { error: e.message || String(e) }; }
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || String(e) });
  }
};
