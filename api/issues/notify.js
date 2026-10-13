// POST /api/issues/notify  { kind: "new" | "comment", issue: <uuid>, comment?: <uuid> }
// Sends the commissioner an email when a member opens an issue, and tells the
// person who opened it when someone replies. The caller's Supabase session
// token is forwarded to the database, so only a signed-in league member can
// trigger a mail, and the text comes from the stored row, never the request.
//
// Vercel env: RESEND_API_KEY (Sean adds it), optional ISSUES_TO (defaults to
// the commissioner's address), ISSUES_FROM (defaults to league@crysterbaters.com).

const SB_URL = process.env.SUPABASE_URL || "https://gtpvhvnshzyiczyxwpsv.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable__Y0fvTsbMqyQHPlw8ycQ-A_8OQzR0lg";
const TO = process.env.ISSUES_TO || "seanlewis08@gmail.com";
const FROM = process.env.ISSUES_FROM || "Crysterbaters <league@crysterbaters.com>";
const SITE = "https://crysterbaters.com";
const LABEL = { open: "Open", in_progress: "In progress", closed: "Closed" };
const KIND = { bug: "Bug", idea: "Idea", question: "Question", other: "Other" };

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function para(s) { return esc(s).split(/\n{2,}/).map(p => "<p style=\"margin:0 0 10px\">" + p.replace(/\n/g, "<br>") + "</p>").join(""); }
function who(email) { return (email || "").split("@")[0] || "A manager"; }

async function sb(path, token) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { headers: { apikey: SB_ANON, Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!r.ok) throw new Error("db " + r.status);
  return r.json();
}

async function send(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: "no RESEND_API_KEY" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("resend " + r.status + " " + (j.message || ""));
  return { id: j.id };
}

function shell(inner, link) {
  return "<div style=\"font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#22190E;max-width:560px\">" + inner +
    "<p style=\"margin:18px 0 0\"><a href=\"" + link + "\" style=\"display:inline-block;background:#C1571A;color:#fff;text-decoration:none;padding:9px 14px;border-radius:4px;font-weight:600\">Open on crysterbaters.com</a></p>" +
    "<p style=\"margin:18px 0 0;font-size:12px;color:#7E7362\">You're getting this because of the Issues page on the league site.</p></div>";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!token) { res.status(401).json({ error: "sign in first" }); return; }
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const id = String(body.issue || ""), kind = body.kind === "comment" ? "comment" : "new";
  if (!/^[0-9a-f-]{36}$/.test(id)) { res.status(400).json({ error: "bad issue id" }); return; }
  try {
    const rows = await sb("issues?id=eq." + id + "&select=id,num,title,body,kind,status,created_by_email,created_at", token[1]);
    const it = rows[0];
    if (!it) { res.status(403).json({ error: "not yours to see" }); return; }
    const link = SITE + "/#issues/" + it.id, tag = "#" + it.num + " " + it.title;
    const out = [];
    if (kind === "new") {
      const html = shell("<p style=\"margin:0 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7E7362\">New issue · " + esc(KIND[it.kind] || it.kind) + "</p>" +
        "<h2 style=\"margin:0 0 10px;font-size:20px\">" + esc(tag) + "</h2>" +
        "<p style=\"margin:0 0 12px;color:#7E7362\">Opened by " + esc(who(it.created_by_email)) + " (" + esc(it.created_by_email) + ")</p>" +
        (it.body ? para(it.body) : "<p style=\"margin:0;color:#7E7362\">No details given.</p>"), link);
      out.push(await send(TO, "[Crysterbaters] New issue " + tag, html));
    } else {
      const cid = String(body.comment || "");
      if (!/^[0-9a-f-]{36}$/.test(cid)) { res.status(400).json({ error: "bad comment id" }); return; }
      const cs = await sb("issue_comments?id=eq." + cid + "&issue_id=eq." + id + "&select=id,body,created_by_email,created_at", token[1]);
      const c = cs[0];
      if (!c) { res.status(403).json({ error: "comment not found" }); return; }
      const html = shell("<p style=\"margin:0 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#7E7362\">Reply · " + esc(LABEL[it.status] || it.status) + "</p>" +
        "<h2 style=\"margin:0 0 10px;font-size:20px\">" + esc(tag) + "</h2>" +
        "<p style=\"margin:0 0 12px;color:#7E7362\">" + esc(who(c.created_by_email)) + " wrote:</p>" + para(c.body), link);
      const subject = "[Crysterbaters] Re: " + tag;
      const from = (c.created_by_email || "").toLowerCase();
      const recipients = new Set();
      if (from !== TO.toLowerCase()) recipients.add(TO);                                   // the commissioner hears about every reply but his own
      if (it.created_by_email && it.created_by_email.toLowerCase() !== from) recipients.add(it.created_by_email); // the reporter hears replies from others
      for (const to of recipients) out.push(await send(to, subject, html));
    }
    res.status(200).json({ ok: true, sent: out });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
