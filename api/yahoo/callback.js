const L = require("./_lib");
module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, L.origin(req));
    const code = u.searchParams.get("code"), state = u.searchParams.get("state"), err = u.searchParams.get("error");
    const c = L.cookies(req);
    L.clearCookie(res, L.STATE);
    if (err) throw new Error("Yahoo said: " + (u.searchParams.get("error_description") || err));
    if (!code || !state || state !== c[L.STATE]) throw new Error("Sign-in didn't match the request it started from. Try again.");
    const s = await L.tokenRequest(req, { grant_type: "authorization_code", code: code });
    if (!s.rt) throw new Error("Yahoo signed you in but sent no refresh token, so the connection can't be kept (access token " + String(s.at || "").length + " chars).");
    L.setCookie(res, L.COOKIE, L.sessionCookie(s));
    res.statusCode = 302; res.setHeader("Location", "/#manager?yahoo=connected"); res.end();
  } catch (e) {
    res.statusCode = 302; res.setHeader("Location", "/#manager?yahoo=" + encodeURIComponent(e.message)); res.end();
  }
};
