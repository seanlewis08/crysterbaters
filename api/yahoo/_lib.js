// Shared bits for the Yahoo Fantasy connection. Tokens live only in an encrypted,
// HttpOnly cookie in the manager's own browser; nothing from Yahoo is stored on
// the server. Env (set in Vercel by the commissioner, never in the repo):
//   YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_COOKIE_SECRET (any long random string)
const crypto = require("crypto");

const AUTH = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN = "https://api.login.yahoo.com/oauth2/get_token";
const API = "https://fantasysports.yahooapis.com/fantasy/v2";
const COOKIE = "cb_yahoo";
const STATE = "cb_yahoo_state";
const LEAGUE_ID = "33689";
// The scope has to match the app's registered permission exactly (Yahoo answers "invalid scope"
// otherwise). The app is registered with Fantasy Sports - Read, so fspt-r; set YAHOO_SCOPE in
// Vercel only if the app's permission ever changes. This code only ever reads.
const SCOPE = process.env.YAHOO_SCOPE || "fspt-r";

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing " + name + " in Vercel environment variables");
  return v;
}
function origin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return "https://" + host;
}
function redirectUri(req) { return origin(req) + "/api/yahoo/callback"; }

function key() { return crypto.createHash("sha256").update(env("YAHOO_COOKIE_SECRET")).digest(); }
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}
function open(str) {
  try {
    const buf = Buffer.from(str, "base64url");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8"));
  } catch (e) { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("="); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAge, path) {
  const parts = [name + "=" + encodeURIComponent(value), "Path=" + (path || "/api/yahoo"), "HttpOnly", "Secure", "SameSite=Lax"];
  parts.push("Max-Age=" + (maxAge == null ? 60 * 60 * 24 * 60 : maxAge));
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [].concat(prev || [], parts.join("; ")));
}
function clearCookie(res, name, path) { setCookie(res, name, "", 0, path); }

async function tokenRequest(req, body) {
  const basic = Buffer.from(env("YAHOO_CLIENT_ID") + ":" + env("YAHOO_CLIENT_SECRET")).toString("base64");
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({ redirect_uri: redirectUri(req) }, body)).toString()
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Yahoo token: " + (j.error_description || j.error || r.status));
  // a refresh response may omit refresh_token; keep the one we already had
  return { at: j.access_token, rt: j.refresh_token || body.refresh_token || "", exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
}
/* What goes in the cookie. Yahoo's access tokens run to a few thousand characters, and a
   browser silently drops any cookie over 4 KB, so the cookie keeps the access token only
   when the whole thing stays comfortably small; otherwise just the (short) refresh token,
   and each request trades it for a fresh access token. */
const COOKIE_MAX = 3800;
function sessionCookie(s) {
  let sealed = seal({ at: s.at, rt: s.rt, exp: s.exp });
  if (sealed.length > COOKIE_MAX) sealed = seal({ rt: s.rt });
  return sealed;
}
/* a valid access token from the cookie, refreshing when missing or expired; null when not connected */
async function session(req, res) {
  const c = cookies(req)[COOKIE];
  if (!c) { res.cbWhy = "no_cookie"; return null; }
  let s = open(c);
  if (!s) { res.cbWhy = "cookie_unreadable"; return null; }
  if (!s.rt) { res.cbWhy = "no_refresh_token"; return null; }
  if (!s.at || Date.now() > (s.exp || 0)) {
    s = await tokenRequest(req, { grant_type: "refresh_token", refresh_token: s.rt });
    setCookie(res, COOKIE, sessionCookie(s));
  }
  return s;
}
async function yahoo(s, path) {
  const r = await fetch(API + path + (path.indexOf("?") < 0 ? "?format=json" : "&format=json"), {
    headers: { "Authorization": "Bearer " + s.at, "Accept": "application/json" }
  });
  if (r.status === 401) throw Object.assign(new Error("Yahoo session expired"), { code: 401 });
  if (!r.ok) {
    // pass Yahoo's own reason through (it explains 403s); never includes the token
    const t = (await r.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error("Yahoo " + r.status + " on " + path + (t ? " — " + t : ""));
  }
  return r.json();
}
/* Yahoo's JSON nests arrays-of-single-key-objects everywhere, sometimes an array whose first
   element is itself such an array (a team is [[{team_key},{name},...],{team_stats}]); and lists
   come as {"0":…,"1":…,count:n}. Fold all of that into plain objects and arrays. */
function fold(v) {
  if (Array.isArray(v)) {
    const parts = v.map(fold);
    if (parts.length && parts.every(x => x && typeof x === "object" && !Array.isArray(x))) {
      // merge only when the pieces carry different keys ([{team_key},{name}]); a repeated key
      // ([{stat},{stat},…]) is a real list and stays one
      const seen = {}; let clash = false;
      parts.forEach(x => Object.keys(x).forEach(k => { if (seen[k]) clash = true; seen[k] = 1; }));
      if (!clash) { const o = {}; parts.forEach(x => Object.assign(o, x)); return o; }
    }
    return parts;
  }
  if (v && typeof v === "object") {
    if (typeof v.count === "number") {
      const list = []; for (let i = 0; i < v.count; i++) if (v[i] != null) list.push(fold(v[i])); return list;
    }
    const o = {}; Object.keys(v).forEach(k => { o[k] = fold(v[k]); }); return o;
  }
  return v;
}
function json(res, status, body) { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); }

module.exports = { AUTH, COOKIE, STATE, LEAGUE_ID, SCOPE, env, origin, redirectUri, seal, open, cookies, setCookie, clearCookie, tokenRequest, session, sessionCookie, yahoo, fold, json };
