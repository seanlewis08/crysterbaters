// Discord Interactions endpoint: slash commands and button clicks.
// Set this URL (https://crysterbaters.com/api/discord) as the
// "Interactions Endpoint URL" on the Discord application.
"use strict";

const supa = require("./_lib/supa");
const dc = require("./_lib/discord");
const poll = require("./_lib/poll");
const yahoo = require("./_lib/yahoo-server");
const welcome = require("./_lib/welcome");
const dues = require("./_lib/dues");

module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const reply = (res, type, data) => { res.status(200).json({ type, data }); };
const whisper = (res, content) => reply(res, dc.RT.CHANNEL_MESSAGE, { content, flags: dc.EPHEMERAL, allowed_mentions: { parse: [] } });

const userOf = (ix) => (ix.member && ix.member.user) || ix.user || {};
const opt = (ix, name) => { const o = ((ix.data && ix.data.options) || []).find((x) => x.name === name); return o ? o.value : undefined; };

// "A | B | C" or "A, B, C" → ["A","B","C"]
function parseOptions(s) {
  const sep = s.includes("|") ? "|" : s.includes(";") ? ";" : ",";
  return s.split(sep).map((x) => x.trim()).filter(Boolean).slice(0, 12);
}

// "6h", "2d", "90m", "45" (hours) → ISO timestamp, or null.
function parseCloses(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([mhd]?)$/i);
  if (!m) return undefined; // invalid
  const n = parseFloat(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  const ms = unit === "m" ? n * 60e3 : unit === "d" ? n * 864e5 : n * 36e5;
  return new Date(Date.now() + ms).toISOString();
}

async function handleCommand(ix, res) {
  const name = ix.data.name;
  const user = userOf(ix);
  const me = await supa.profileByDiscord(user.id);

  if (name === "link") {
    const teamId = String(opt(ix, "team") || "");
    if (teamId.startsWith("unmapped:")) {
      return whisper(res, "That Yahoo team isn't matched to a site team yet — ask Sean to map it (team_map) and try again.");
    }
    const team = supa.teamById(teamId);
    if (!team) return whisper(res, "Pick a team from the list.");
    const liveName = await yahoo.teamName(teamId);
    const prof = await supa.profileByTeam(teamId);
    if (!prof) return whisper(res, "Nobody has claimed **" + liveName + "** on the site yet. Claim it first: <https://crysterbaters.com/#signup>, then run /link again.");
    if (prof.discord_id && prof.discord_id !== user.id) return whisper(res, "**" + liveName + "** is already linked to another Discord account. Ask Sean to unlink it if that's wrong.");
    if (me && me.team_id !== teamId) await supa.update("profiles", "user_id=eq." + me.user_id, { discord_id: null });
    await supa.update("profiles", "user_id=eq." + prof.user_id, { discord_id: user.id });
    return whisper(res, "Linked. You vote here as **" + supa.nameFor(prof, prof.email) + "** (" + liveName + "). Your Discord votes show up on the site and vice versa.");
  }

  if (name === "unlink") {
    if (!me) return whisper(res, "You're not linked to a team.");
    await supa.update("profiles", "user_id=eq." + me.user_id, { discord_id: null });
    return whisper(res, "Unlinked.");
  }

  if (name === "whoami") {
    if (!me) return whisper(res, "Not linked yet — run **/link** and pick your team.");
    return whisper(res, "You're **" + supa.nameFor(me, me.email) + "** — " + (await yahoo.teamName(me.team_id)) + ".");
  }

  if (name === "dues") {
    const out = await dues.handleCommand(ix, me);
    return reply(res, out.type, out.data);
  }

  if (name === "poll") {
    if (!me) return whisper(res, "Run **/link** first so the poll is created under your name.");
    const question = String(opt(ix, "question") || "").trim();
    const options = parseOptions(String(opt(ix, "options") || ""));
    const visibility = opt(ix, "visibility") || "named";
    const closes = parseCloses(opt(ix, "closes"));
    if (question.length < 1 || question.length > 300) return whisper(res, "Question must be 1–300 characters.");
    if (options.length < 2) return whisper(res, "Give at least two options, separated by `|` — e.g. `Yes | No | Abstain`.");
    if (closes === undefined) return whisper(res, "Couldn't read the closing time. Use something like `6h`, `2d` or `90m`.");
    const rows = await supa.insert("polls", {
      question, options, visibility, closes_at: closes,
      created_by: me.user_id, created_by_email: me.email,
    });
    const created = rows[0];
    // Post now rather than waiting for the DB trigger; sync() is idempotent.
    try { await poll.sync(created.id); } catch (e) { console.error("post after /poll failed", e); }
    return whisper(res, "Poll posted in <#" + process.env.DISCORD_POLLS_CHANNEL_ID + "> and on the site.");
  }

  return whisper(res, "Unknown command.");
}

async function handleComponent(ix, res) {
  if (String(ix.data.custom_id || "").startsWith("fav:")) {
    const out = await welcome.handleComponent(ix);
    return out ? reply(res, out.type, out.data) : whisper(res, "Unknown picker.");
  }
  if (String(ix.data.custom_id || "").startsWith("dues:")) {
    const out = await dues.handleComponent(ix, await supa.profileByDiscord(userOf(ix).id));
    return out ? reply(res, out.type, out.data) : whisper(res, "Unknown button.");
  }
  const [kind, pollId, idxStr] = String(ix.data.custom_id || "").split(":");
  const user = userOf(ix);
  const me = await supa.profileByDiscord(user.id);
  if (!me) return whisper(res, "Run **/link** and pick your team first, then vote.");

  const p = await supa.getPoll(pollId);
  if (!p) return whisper(res, "That poll no longer exists.");

  if (kind === "vote") {
    if (!supa.pollIsOpen(p)) {
      const payload = await poll.sync(pollId);
      return reply(res, dc.RT.UPDATE_MESSAGE, payload);
    }
    const idx = parseInt(idxStr, 10);
    if (!(idx >= 0 && idx < p.options.length)) return whisper(res, "Bad option.");
    await supa.upsert("votes", { poll_id: pollId, user_id: me.user_id, voter_email: me.email, option_index: idx }, "poll_id,user_id");
    const payload = await poll.sync(pollId);
    return reply(res, dc.RT.UPDATE_MESSAGE, payload);
  }

  if (kind === "close") {
    const allowed = p.created_by === me.user_id || (await supa.isCommissioner(me));
    if (!allowed) return whisper(res, "Only whoever asked the question, or the commissioner, can close it.");
    await supa.update("polls", "id=eq." + pollId, { closed: true });
    const payload = await poll.sync(pollId);
    return reply(res, dc.RT.UPDATE_MESSAGE, payload);
  }

  return whisper(res, "Unknown button.");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("POST only");
  const raw = await readRaw(req);
  const ok = dc.verifySignature(
    process.env.DISCORD_PUBLIC_KEY,
    req.headers["x-signature-ed25519"],
    req.headers["x-signature-timestamp"],
    raw
  );
  if (!ok) return res.status(401).send("bad signature");

  let ix;
  try { ix = JSON.parse(raw.toString("utf8")); } catch (_) { return res.status(400).send("bad json"); }

  if (ix.type === dc.IT.PING) return res.status(200).json({ type: dc.RT.PONG });

  try {
    if (ix.type === dc.IT.AUTOCOMPLETE) {
      const focused = ((ix.data && ix.data.options) || []).find((o) => o.focused) || {};
      const choices = ix.data.name === "link" ? await yahoo.linkChoices(focused.value || "") : [];
      return reply(res, dc.RT.AUTOCOMPLETE_RESULT, { choices });
    }
    if (ix.type === dc.IT.APPLICATION_COMMAND) return await handleCommand(ix, res);
    if (ix.type === dc.IT.MESSAGE_COMPONENT) return await handleComponent(ix, res);
    if (ix.type === dc.IT.MODAL_SUBMIT) {
      const out = await welcome.handleModal(ix);
      return out ? reply(res, out.type, out.data) : whisper(res, "Unknown form.");
    }
    return whisper(res, "Unsupported interaction.");
  } catch (e) {
    console.error(e);
    return whisper(res, "Something broke: " + (e.message || e));
  }
};

module.exports._test = { parseOptions, parseCloses };
