const L = require("./_lib");
const crypto = require("crypto");
module.exports = async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    L.setCookie(res, L.STATE, state, 600);
    const u = new URL(L.AUTH);
    u.searchParams.set("client_id", L.env("YAHOO_CLIENT_ID"));
    u.searchParams.set("redirect_uri", L.redirectUri(req));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", L.SCOPE);
    u.searchParams.set("state", state);
    u.searchParams.set("language", "en-us");
    res.statusCode = 302; res.setHeader("Location", u.toString()); res.end();
  } catch (e) { L.json(res, 500, { error: e.message }); }
};
