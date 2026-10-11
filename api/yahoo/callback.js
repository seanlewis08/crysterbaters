const L = require("./_lib");
module.exports = async (req, res) => {
  var back = "manager";
  try {
    const u = new URL(req.url, L.origin(req));
    const code = u.searchParams.get("code"), state = u.searchParams.get("state"), err = u.searchParams.get("error");
    const c = L.cookies(req);
    const saved = String(c[L.STATE] || "").split("|");
    back = (saved[1] || "manager").replace(/[^a-z0-9/]/gi, "") || "manager";
    L.clearCookie(res, L.STATE);
    if (err) throw new Error("Yahoo said: " + (u.searchParams.get("error_description") || err));
    if (!code || !state || state !== saved[0]) throw new Error("Sign-in didn't match the request it started from. Try again.");
    const s = await L.tokenRequest(req, { grant_type: "authorization_code", code: code });
    if (!s.rt) throw new Error("Yahoo signed you in but sent no refresh token, so the connection can't be kept (access token " + String(s.at || "").length + " chars).");
    const ck = L.sessionCookie(s);
    L.setCookie(res, L.COOKIE, ck);
    res.statusCode = 302; res.setHeader("Location", "/#" + back + "?yahoo=connected"); res.end();
  } catch (e) {
    res.statusCode = 302; res.setHeader("Location", "/#" + back + "?yahoo=" + encodeURIComponent(e.message)); res.end();
  }
};
