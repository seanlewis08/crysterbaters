// Commissioner only, once: copy the Yahoo refresh token from this browser's
// site cookie into discord_settings so the Discord functions can read team
// names live. Visit while connected to Yahoo on the site:
//   https://crysterbaters.com/api/yahoo/share?key=<SYNC_SECRET>
// The access token is not kept; the refresh token lives only in that
// service-role-only row (and is rotated there when Yahoo issues a new one).
"use strict";

const L = require("./_lib");
const supa = require("../_lib/supa");

module.exports = async (req, res) => {
  const secret = process.env.SYNC_SECRET || "";
  const key = new URL(req.url, L.origin(req)).searchParams.get("key") || "";
  if (!secret || key !== secret) return L.json(res, 401, { error: "nope" });
  const c = L.cookies(req)[L.COOKIE];
  const s = c ? L.open(c) : null;
  if (!s || !s.rt) {
    return L.json(res, 400, { error: "not_connected", hint: "Connect to Yahoo on your team page first (same browser), then open this URL again." });
  }
  try {
    await supa.update("discord_settings", "id=eq.1", { yahoo_refresh_token: s.rt });
  } catch (e) {
    return L.json(res, 500, { error: e.message });
  }
  return L.json(res, 200, { ok: true, note: "Yahoo connected for the Discord functions. You can close this tab." });
};
