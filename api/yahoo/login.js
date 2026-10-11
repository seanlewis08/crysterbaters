const L = require("./_lib");
const crypto = require("crypto");
module.exports = async (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    // where to land afterwards: "manager" or "team/<id>" (letters, digits and one slash only)
    const back = String(new URL(req.url, L.origin(req)).searchParams.get("back") || "manager").replace(/[^a-z0-9/]/gi, "").slice(0, 40) || "manager";
    L.setCookie(res, L.STATE, state + "|" + back, 600);
    const u = new URL(L.AUTH);
    u.searchParams.set("client_id", L.env("YAHOO_CLIENT_ID"));
    u.searchParams.set("redirect_uri", L.redirectUri(req));
    u.searchParams.set("response_type", "code");
    if (L.SCOPE) u.searchParams.set("scope", L.SCOPE);
    u.searchParams.set("state", state);
    u.searchParams.set("language", "en-us");
    res.statusCode = 302; res.setHeader("Location", u.toString()); res.end();
  } catch (e) { L.json(res, 500, { error: e.message }); }
};
