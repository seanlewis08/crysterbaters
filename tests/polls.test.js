// End-to-end-ish tests for the Discord poll functions with an in-memory
// fake of Supabase REST and the Discord API behind a stubbed fetch.
// Run: node tests/polls.test.js
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { EventEmitter } = require("events");

process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
process.env.DISCORD_BOT_TOKEN = "bot";
process.env.DISCORD_APP_ID = "app1";
process.env.DISCORD_POLLS_CHANNEL_ID = "chan1";
process.env.SYNC_SECRET = "s3cret";
process.env.YAHOO_CLIENT_ID = "yid"; process.env.YAHOO_CLIENT_SECRET = "ysec"; process.env.YAHOO_COOKIE_SECRET = "cookie";

// ---- Ed25519 keys for signature tests --------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
process.env.DISCORD_PUBLIC_KEY = pubRaw;
function sign(ts, body) {
  return crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString("hex");
}

// ---- in-memory "database" --------------------------------------------
const db = {
  league_settings: [{ id: 1, commissioner_email: "sean@x.com" }],
  profiles: [
    { user_id: "u-sean", email: "sean@x.com", team_id: "jalenba", display_name: null, discord_id: "d-sean" },
    { user_id: "u-ben", email: "ben@x.com", team_id: "knuepp", display_name: "Benny", discord_id: null },
    { user_id: "u-kabir", email: "kabir@x.com", team_id: "giannis", display_name: null, discord_id: "d-kabir" },
  ],
  polls: [],
  votes: [],
  poll_messages: [],
  discord_settings: [{ id: 1, sync_url: "https://x/api/poll-sync", sync_secret: "s3cret", yahoo_refresh_token: "rt-sean" }],
  team_map: [],
};
// Yahoo: Ben renamed his team; everyone else matches the site's names.
const yahooTeams = [
  { key: "466.l.33689.t.1", name: "Knueppel Kings", nick: "Ben" },
  { key: "466.l.33689.t.2", name: "The JaleNBA", nick: "Sean" },
  { key: "466.l.33689.t.3", name: "Regular Season Giannis", nick: "Myhops" },
];
let yahooCalls = 0;
const discord = { messages: {}, nextId: 100, calls: [], roles: [], memberRoles: {} };

function parseFilters(qs) {
  const q = new URLSearchParams(qs);
  const filters = [];
  for (const [k, v] of q) {
    if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
    const m = v.match(/^(eq|is|lt)\.(.*)$/);
    if (m) filters.push({ col: k, op: m[1], val: m[2] });
  }
  return { filters, limit: q.get("limit") ? parseInt(q.get("limit"), 10) : null };
}
function match(row, f) {
  const v = row[f.col];
  if (f.op === "eq") return String(v) === f.val;
  if (f.op === "is") return f.val === "null" ? v == null : f.val === "false" ? v === false : v === true;
  if (f.op === "lt") return v != null && String(v) < f.val;
  return false;
}

async function fakeSupabase(method, path, qs, body, headers) {
  const table = path;
  const { filters, limit } = parseFilters(qs);
  const rows = db[table] || [];
  const json = (x, status) => new Response(JSON.stringify(x), { status: status || 200 });
  if (method === "GET") {
    let out = rows.filter((r) => filters.every((f) => match(r, f)));
    if (limit) out = out.slice(0, limit);
    return json(out);
  }
  if (method === "POST") {
    const conflict = new URLSearchParams(qs).get("on_conflict");
    const row = Object.assign({}, body);
    if (table === "polls") Object.assign(row, { id: "p-" + (db.polls.length + 1), closed: false, created_at: new Date().toISOString() }, body);
    if (table === "votes") row.created_at = row.created_at || new Date().toISOString();
    if (conflict) {
      const keys = conflict.split(",");
      const i = rows.findIndex((r) => keys.every((k) => r[k] === row[k]));
      if (i >= 0) { Object.assign(rows[i], row); return json([rows[i]]); }
    }
    rows.push(row);
    return json([row], 201);
  }
  if (method === "PATCH") {
    const out = rows.filter((r) => filters.every((f) => match(r, f)));
    out.forEach((r) => Object.assign(r, body));
    return json(out);
  }
  if (method === "DELETE") {
    db[table] = rows.filter((r) => !filters.every((f) => match(r, f)));
    return new Response(null, { status: 204 });
  }
  return json({ message: "unsupported" }, 400);
}

async function fakeDiscord(method, path, body) {
  discord.calls.push(method + " " + path);
  const json = (x, status) => new Response(JSON.stringify(x), { status: status || 200 });
  let m;
  if ((m = path.match(/^\/channels\/(\w+)\/messages$/)) && method === "POST") {
    const id = String(discord.nextId++);
    discord.messages[id] = Object.assign({ id, channel_id: m[1] }, body);
    return json(discord.messages[id]);
  }
  if ((m = path.match(/^\/channels\/(\w+)\/messages\/(\w+)$/))) {
    if (!discord.messages[m[2]]) return json({ message: "Unknown Message" }, 404);
    if (method === "PATCH") { Object.assign(discord.messages[m[2]], body); return json(discord.messages[m[2]]); }
    if (method === "DELETE") { delete discord.messages[m[2]]; return new Response(null, { status: 204 }); }
  }
  if ((m = path.match(/^\/applications\/(\w+)\/commands$/)) && method === "PUT") return json(body.map((c, i) => ({ id: String(i), name: c.name })));
  if (path.match(/^\/guilds\/\w+\/roles$/) && method === "GET") return json(discord.roles);
  if (path.match(/^\/guilds\/\w+\/roles$/) && method === "POST") { const r = Object.assign({ id: "r" + discord.nextId++, position: 1 }, body); discord.roles.push(r); return json(r); }
  if ((m = path.match(/^\/guilds\/\w+\/members\/([\w-]+)\/roles\/([\w-]+)$/))) {
    const set = (discord.memberRoles[m[1]] = discord.memberRoles[m[1]] || new Set());
    if (method === "PUT") set.add(m[2]); if (method === "DELETE") set.delete(m[2]);
    return new Response(null, { status: 204 });
  }
  return json({ message: "no route " + method + " " + path }, 404);
}

const webhookPosts = [];
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const method = (init && init.method) || "GET";
  let body;
  if (init && init.body) { try { body = JSON.parse(init.body); } catch (_) { body = String(init.body); } }
  if (u.host === "fake.supabase.co") return fakeSupabase(method, u.pathname.replace("/rest/v1/", ""), u.search.slice(1), body, init.headers);
  if (u.host === "discord.com" && u.pathname.startsWith("/api/webhooks/")) { webhookPosts.push(body); return new Response(JSON.stringify({ id: "wh-msg-" + webhookPosts.length }), { status: 200 }); }
  if (u.host === "discord.com") return fakeDiscord(method, u.pathname.replace("/api/v10", ""), body);
  if (u.host === "api.login.yahoo.com") return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-sean", expires_in: 3600 }), { status: 200 });
  if (u.host === "fantasysports.yahooapis.com" && u.pathname.endsWith("/teams/roster")) {
    const teams = {}; yahooTeams.forEach((t, i) => {
      const players = { 0: { player: [[{ player_key: "p" + i }, { name: { full: "Player " + i } }, { editorial_team_abbr: "BOS" }], { selected_position: [{ position: i === 0 ? "PG" : "BN" }] }] }, count: 1 };
      teams[i] = { team: [[{ team_key: t.key }, { name: t.name }, { managers: [{ manager: { nickname: t.nick } }] }], { roster: { 0: { players } } }] };
    }); teams.count = yahooTeams.length;
    return new Response(JSON.stringify({ fantasy_content: { league: [{ league_key: "466.l.33689" }, { teams }] } }), { status: 200 });
  }
  if (u.host === "fantasysports.yahooapis.com") {
    yahooCalls++;
    const teams = {}; yahooTeams.forEach((t, i) => { teams[i] = { team: [[{ team_key: t.key }, { name: t.name }, { managers: [{ manager: { nickname: t.nick } }] }]] }; }); teams.count = yahooTeams.length;
    return new Response(JSON.stringify({ fantasy_content: { league: [{ league_key: "466.l.33689" }, { teams }] } }), { status: 200 });
  }
  throw new Error("unexpected fetch " + url);
};

// ---- tiny req/res shims ------------------------------------------------
function makeReq(method, body, headers, query) {
  const req = new EventEmitter();
  req.method = method; req.headers = headers || {}; req.query = query || {};
  if (typeof body === "object" && body !== null && !Buffer.isBuffer(body)) req.body = body;
  process.nextTick(() => { if (body !== undefined) req.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body))); req.emit("end"); });
  return req;
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; };
  res.json = (x) => { res.body = x; res.done(); return res; };
  res.send = (x) => { res.body = x; res.done(); return res; };
  res.wait = new Promise((r) => { res.done = r; });
  return res;
}
async function call(handler, req) { const res = makeRes(); await handler(req, res); await res.wait; return res; }

const discordFn = require("../api/discord");
const syncFn = require("../api/poll-sync");
const registerFn = require("../api/discord-register");
const dc = require("../api/_lib/discord");

async function interact(ix) {
  const body = JSON.stringify(ix);
  const ts = String(Math.floor(Date.now() / 1000));
  return call(discordFn, makeReq("POST", body, { "x-signature-ed25519": sign(ts, body), "x-signature-timestamp": ts }));
}
const cmd = (name, options, userId) => ({ type: 2, data: { name, options: Object.entries(options || {}).map(([n, v]) => ({ name: n, value: v })) }, member: { user: { id: userId } } });
const click = (customId, userId) => ({ type: 3, data: { custom_id: customId }, member: { user: { id: userId } } });

(async () => {
  // Signature
  {
    const body = JSON.stringify({ type: 1 });
    const ts = "1";
    const bad = await call(discordFn, makeReq("POST", body, { "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": ts }));
    assert.strictEqual(bad.statusCode, 401, "bad signature rejected");
    const ok = await call(discordFn, makeReq("POST", body, { "x-signature-ed25519": sign(ts, body), "x-signature-timestamp": ts }));
    assert.deepStrictEqual(ok.body, { type: 1 }, "PING → PONG");
    assert.ok(dc.verifySignature(pubRaw, sign("9", "{}"), "9", "{}"));
    assert.ok(!dc.verifySignature(pubRaw, sign("9", "{}"), "10", "{}"), "timestamp is part of the signed message");
  }

  // /link autocomplete: live Yahoo names, mapped to site ids (rename-proof)
  {
    const ac = (typed) => interact({ type: 4, data: { name: "link", options: [{ name: "team", value: typed, focused: true }] }, member: { user: { id: "d-ben" } } });
    let r = await ac("");
    assert.strictEqual(r.body.type, 8);
    const names = r.body.data.choices.map((c) => c.name);
    assert.deepStrictEqual(names, ["Knueppel Kings · Ben", "The JaleNBA · Sean", "Regular Season Giannis · Myhops"]);
    const values = r.body.data.choices.map((c) => c.value);
    assert.deepStrictEqual(values, ["knuepp", "jalenba", "giannis"], "renamed team still maps to knuepp via manager name");
    assert.strictEqual(db.team_map.length, 3, "matches persisted");
    r = await ac("kings");
    assert.deepStrictEqual(r.body.data.choices.map((c) => c.value), ["knuepp"]);
    // Yahoo down → site names, never an empty list
    const saved = yahooTeams.splice(0); const brokenKey = db.discord_settings[0].yahoo_refresh_token; db.discord_settings[0].yahoo_refresh_token = null;
    require("../api/_lib/yahoo-server")._reset();
    r = await ac("");
    assert.strictEqual(r.body.data.choices.length, 10);
    assert.ok(r.body.data.choices.some((c) => c.name === "The JaleNBA · Sean"));
    db.discord_settings[0].yahoo_refresh_token = brokenKey; yahooTeams.push(...saved);
  }

  // /link
  {
    let r = await interact(cmd("link", { team: "knuepp" }, "d-ben"));
    assert.match(r.body.data.content, /Linked\. You vote here as \*\*Benny\*\* \(Knueppel Kings\)/);
    assert.strictEqual(db.profiles.find((p) => p.team_id === "knuepp").discord_id, "d-ben");
    r = await interact(cmd("link", { team: "knuepp" }, "d-stranger"));
    assert.match(r.body.data.content, /already linked to another/);
    r = await interact(cmd("link", { team: "rucker" }, "d-tyler"));
    assert.match(r.body.data.content, /Nobody has claimed/);
    r = await interact(cmd("whoami", {}, "d-ben"));
    assert.match(r.body.data.content, /Benny.*Knueppel Kings/);
  }

  // /poll by a linked user → row + Discord message
  {
    const r = await interact(cmd("poll", { question: "Shorten the season?", options: "Yes | No | Only if dues drop", closes: "2d" }, "d-sean"));
    assert.match(r.body.data.content, /Poll posted/);
    assert.strictEqual(db.polls.length, 1);
    const p = db.polls[0];
    assert.strictEqual(p.created_by, "u-sean");
    assert.strictEqual(p.created_by_email, "sean@x.com");
    assert.deepStrictEqual(p.options, ["Yes", "No", "Only if dues drop"]);
    assert.ok(p.closes_at && new Date(p.closes_at) > new Date());
    assert.strictEqual(db.poll_messages.length, 1);
    const msg = discord.messages[db.poll_messages[0].message_id];
    assert.match(msg.content, /📊 \*\*Shorten the season\?\*\*/);
    assert.match(msg.content, /Asked by Sean · named votes · closes <t:\d+:R>/);
    assert.strictEqual(msg.components.length, 2, "one option row + control row");
    assert.strictEqual(msg.components[0].components.length, 3);
    assert.strictEqual(msg.components[0].components[0].custom_id, "vote:" + p.id + ":0");
    assert.strictEqual(msg.components[1].components[0].label, "Close poll");
    assert.match(msg.content, /0 of 3 voted/);
  }
  const pollId = db.polls[0].id;

  // Unlinked click is refused; linked click records a vote under the real user
  {
    let r = await interact(click("vote:" + pollId + ":1", "d-nobody"));
    assert.match(r.body.data.content, /Run \*\*\/link\*\*/);
    assert.strictEqual(db.votes.length, 0);
    r = await interact(click("vote:" + pollId + ":1", "d-ben"));
    assert.strictEqual(r.body.type, 7, "UPDATE_MESSAGE");
    assert.deepStrictEqual(db.votes.map((v) => [v.user_id, v.voter_email, v.option_index]), [["u-ben", "ben@x.com", 1]]);
    assert.match(r.body.data.content, /2️⃣ \*\*No\*\* — 1 .*Benny/);
    // change vote
    r = await interact(click("vote:" + pollId + ":2", "d-ben"));
    assert.strictEqual(db.votes.length, 1, "upsert on (poll_id,user_id)");
    assert.strictEqual(db.votes[0].option_index, 2);
    assert.match(r.body.data.content, /1 of 3 voted/);
  }

  // Site-side vote arrives via the DB trigger payload → message re-rendered
  {
    db.votes.push({ poll_id: pollId, user_id: "u-kabir", voter_email: "kabir@x.com", option_index: 0, created_at: new Date().toISOString() });
    let r = await call(syncFn, makeReq("POST", { type: "INSERT", table: "votes", record: db.votes[1] }, { "x-cb-secret": "wrong" }));
    assert.strictEqual(r.statusCode, 401);
    r = await call(syncFn, makeReq("POST", { type: "INSERT", table: "votes", record: db.votes[1] }, { "x-cb-secret": "s3cret" }));
    assert.strictEqual(r.statusCode, 200);
    const msg = discord.messages[db.poll_messages[0].message_id];
    assert.match(msg.content, /1️⃣ \*\*Yes\*\* — 1 .*Kabir/);
    assert.match(msg.content, /2 of 3 voted/);
  }

  // Anonymous-until-close hides names while open, shows them after close
  {
    const rows = await fakeSupabase("POST", "polls", "", { question: "Secret ballot", options: ["A", "B"], visibility: "anon_until_close", created_by: "u-sean", created_by_email: "sean@x.com" });
    const p2 = JSON.parse(await rows.text())[0];
    await call(syncFn, makeReq("POST", { type: "INSERT", table: "polls", record: p2 }, { "x-cb-secret": "s3cret" }));
    await interact(click("vote:" + p2.id + ":0", "d-kabir"));
    let msg = discord.messages[db.poll_messages.find((m) => m.poll_id === p2.id).message_id];
    assert.match(msg.content, /1️⃣ \*\*A\*\* — 1 {2}`/);
    assert.ok(!/Kabir/.test(msg.content), "no names while open");
    // Ben (not creator, not commissioner) cannot close; Sean can
    let r = await interact(click("close:" + p2.id, "d-ben"));
    assert.match(r.body.data.content, /Only whoever asked/);
    r = await interact(click("close:" + p2.id, "d-sean"));
    assert.strictEqual(r.body.type, 7);
    assert.strictEqual(db.polls.find((x) => x.id === p2.id).closed, true);
    msg = discord.messages[db.poll_messages.find((m) => m.poll_id === p2.id).message_id];
    assert.match(msg.content, /\*\*Closed\*\*/);
    assert.match(msg.content, /Kabir/, "names revealed after close");
    assert.ok(msg.components[0].components.every((b) => b.disabled), "buttons disabled");
    assert.strictEqual(msg.components[1].components.length, 1, "no Close button once closed");
    // voting on a closed poll just re-renders
    r = await interact(click("vote:" + p2.id + ":1", "d-ben"));
    assert.strictEqual(db.votes.filter((v) => v.poll_id === p2.id).length, 1);
  }

  // Delete on the site removes the Discord message
  {
    const p2 = db.polls[1];
    db.polls = db.polls.filter((x) => x.id !== p2.id);
    db.poll_messages_before = db.poll_messages.length;
    const mid = db.poll_messages.find((m) => m.poll_id === p2.id).message_id;
    await call(syncFn, makeReq("POST", { type: "DELETE", table: "polls", old_record: p2 }, { "x-cb-secret": "s3cret" }));
    assert.ok(!discord.messages[mid], "discord message deleted");
    assert.ok(!db.poll_messages.find((m) => m.poll_id === p2.id));
  }

  // Sweep: a poll whose closes_at passed gets re-rendered as closed
  {
    db.polls[0].closes_at = new Date(Date.now() - 1000).toISOString();
    const r = await call(syncFn, makeReq("GET", undefined, { "x-vercel-cron": "1" }));
    assert.deepStrictEqual(r.body, { swept: 1 });
    const msg = discord.messages[db.poll_messages[0].message_id];
    assert.match(msg.content, /\*\*Closed\*\* <t:\d+:D>/);
    assert.strictEqual(db.poll_messages[0].closed_rendered, true);
    const again = await call(syncFn, makeReq("GET", undefined, { "x-vercel-cron": "1" }));
    assert.deepStrictEqual(again.body, { swept: 0 }, "idempotent");
  }

  // Register endpoint
  {
    let r = await call(registerFn, makeReq("GET", undefined, {}, { key: "nope" }));
    assert.strictEqual(r.statusCode, 401);
    r = await call(registerFn, makeReq("GET", undefined, {}, { key: "s3cret" }));
    assert.deepStrictEqual(r.body.registered, ["link", "unlink", "whoami", "poll"]);
    assert.strictEqual(registerFn.COMMANDS[0].options[0].autocomplete, true);
  }

  // /api/teams: live names + rosters keyed by site team id
  {
    const teamsFn = require("../api/teams");
    assert.strictEqual(teamsFn._test.slot("PG"), "G"); assert.strictEqual(teamsFn._test.slot("PF"), "F");
    assert.strictEqual(teamsFn._test.slot("Util"), "Util"); assert.strictEqual(teamsFn._test.slot("IL+"), "IL"); assert.strictEqual(teamsFn._test.slot("BN"), "BN");
    teamsFn._test.reset();
    const r = await call(teamsFn, makeReq("GET", undefined, {}, {}));
    assert.strictEqual(r.statusCode, 200);
    const ben = r.body.teams.find((t) => t.id === "knuepp");
    assert.ok(ben, "renamed Yahoo team keyed to knuepp");
    assert.strictEqual(ben.name, "Knueppel Kings");
    assert.deepStrictEqual(ben.roster[0], ["G", "Player 0", "BOS", ""]);
    const sean = r.body.teams.find((t) => t.id === "jalenba");
    assert.strictEqual(sean.roster[0][0], "BN");
    const again = await call(teamsFn, makeReq("GET", undefined, {}, {}));
    assert.strictEqual(again.body.built, r.body.built, "served from cache");
  }


  // #site-updates: which changes get announced, and how they read
  {
    const ev = require("../api/_lib/site-events");
    const ctx = { profileByUser: async () => ({ display_name: "Sean", team_id: "jalenba" }), getVotes: async () => [{ option_index: 0 }, { option_index: 0 }, { option_index: 1 }], pollsChannel: "123" };
    const poll = { id: "p1", question: "Expand the IL?", options: ["Yes", "No"], closes_at: "2026-10-20T00:00:00Z", created_by: "u1", created_by_email: "seanlewis08@gmail.com", closed: false };
    let e = await ev.describe({ type: "INSERT", table: "polls", record: poll }, ctx);
    assert.ok(e && /New poll: Expand the IL\?/.test(e.embed.title));
    assert.ok(/🇦 Yes\n🇧 No/.test(e.embed.description) && /<#123>/.test(e.embed.description));
    assert.strictEqual(e.embed.footer.text, "Opened by Sean");
    e = await ev.describe({ type: "UPDATE", table: "polls", record: Object.assign({}, poll, { closed: true }), old_record: poll }, ctx);
    assert.ok(/Poll closed/.test(e.embed.title) && /Result: \*\*Yes\*\*/.test(e.embed.description) && /\*\*Yes\*\* — 2\nNo — 1/.test(e.embed.description));
    assert.strictEqual(e.embed.footer.text, "3 votes");
    assert.strictEqual(await ev.describe({ type: "UPDATE", table: "polls", record: Object.assign({}, poll, { question: "edited" }), old_record: poll }, ctx), null, "edits are quiet");
    assert.strictEqual(await ev.describe({ type: "INSERT", table: "votes", record: { poll_id: "p1" } }, ctx), null, "votes are quiet");
    const due = { season: "2026-27", team_id: "knuepp", paid: true, method: "venmo", confirmed: false };
    e = await ev.describe({ type: "UPDATE", table: "dues_payments", record: due, old_record: Object.assign({}, due, { paid: false }) }, ctx);
    assert.ok(/Dues paid: The Knuepp Sluepps \(Ben\)/.test(e.embed.title) && /via Venmo/.test(e.embed.description));
    e = await ev.describe({ type: "UPDATE", table: "dues_payments", record: Object.assign({}, due, { confirmed: true }), old_record: due }, ctx);
    assert.ok(/Dues confirmed/.test(e.embed.title));
    assert.strictEqual(await ev.describe({ type: "UPDATE", table: "dues_payments", record: due, old_record: due }, ctx), null);
    e = await ev.describe({ type: "INSERT", table: "badge_awards", record: { badge_id: "trader-joe", team_id: "freaky", season: "2026–27", note: "Week 4" } }, ctx);
    assert.ok(/Badge awarded: Trader Joe/.test(e.embed.title) && /Real Freaky Naughty/.test(e.embed.description) && /Week 4/.test(e.embed.description));
    assert.strictEqual(ev.badgeName("some-new-badge"), "Some New Badge");
    const kr = { id: "k1", team_id: "ant", season: "2026-27", player: "Deni Avdija", nba_team: "POR", status: "pending", note: "trading for him" };
    e = await ev.describe({ type: "INSERT", table: "keeper_requests", record: kr }, ctx);
    assert.ok(/Keeper request: Deni Avdija \(POR\)/.test(e.embed.title) && /> trading for him/.test(e.embed.description));
    e = await ev.describe({ type: "UPDATE", table: "keeper_requests", record: Object.assign({}, kr, { status: "declined", reply: "no" }), old_record: kr }, ctx);
    assert.ok(/Keeper declined: Deni Avdija/.test(e.embed.title) && /> no/.test(e.embed.description));
    const ag = { id: "a1", title: "Move the trade deadline", details: "Two weeks earlier", status: "open", created_by: "u1", created_by_email: "x@y.z" };
    e = await ev.describe({ type: "INSERT", table: "agenda", record: ag }, ctx);
    assert.ok(/New open item: Move the trade deadline/.test(e.embed.title) && e.embed.footer.text === "Raised by Sean");
    e = await ev.describe({ type: "UPDATE", table: "agenda", record: Object.assign({}, ag, { status: "decided", outcome: "Yes, Feb 1" }), old_record: ag }, ctx);
    assert.ok(/Decided: Move the trade deadline/.test(e.embed.title) && /Yes, Feb 1/.test(e.embed.description));
    const is = { num: 7, title: "Keeper page 404s", kind: "bug", status: "open", created_by: "u1" };
    e = await ev.describe({ type: "INSERT", table: "issues", record: is }, ctx);
    assert.ok(/🐛 Bug #7: Keeper page 404s/.test(e.embed.title));
    e = await ev.describe({ type: "UPDATE", table: "issues", record: Object.assign({}, is, { status: "closed" }), old_record: is }, ctx);
    assert.ok(/Closed #7/.test(e.embed.title));
    const ch = { title: "Usage vs value", author: "Kabir", pinned: true };
    e = await ev.describe({ type: "UPDATE", table: "charts", record: ch, old_record: Object.assign({}, ch, { pinned: false }) }, ctx);
    assert.ok(/Chart of the week: Usage vs value/.test(e.embed.title) && /by Kabir/.test(e.embed.description));
    assert.strictEqual(await ev.describe({ type: "INSERT", table: "charts", record: ch }, ctx), null, "new charts are quiet until pinned");

    // the endpoint: auth, skip, post through the webhook
    process.env.SITE_UPDATES_WEBHOOK = "https://discord.com/api/webhooks/1/tok";
    let r = await call(syncFn, makeReq("POST", { type: "INSERT", table: "badge_awards", record: {} }, { "x-cb-secret": "wrong" }, {}));
    assert.strictEqual(r.statusCode, 401);
    webhookPosts.length = 0;
    r = await call(syncFn, makeReq("POST", { type: "INSERT", table: "badge_awards", record: { badge_id: "homer", team_id: "jalenba", season: "2026–27" } }, { "x-cb-secret": process.env.SYNC_SECRET }, {}));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.site && r.body.site.posted, JSON.stringify(r.body));
    assert.strictEqual(webhookPosts.length, 1);
    assert.strictEqual(webhookPosts[0].username, "Crysterbaters");
    assert.ok(/Badge awarded: Homer/.test(webhookPosts[0].embeds[0].title));
  }


  // #welcome pickers: team / zone / ping dropdowns and the favorite-player modal
  {
    const w = require("../api/_lib/welcome");
    assert.strictEqual(w.roleSpecs().length, 30 + 5 + 4);
    assert.strictEqual(w.welcomeMessage().components.length, 3);
    assert.strictEqual(w.cleanPlayerName("luka  DONCIC jr."), "Luka Doncic Jr.");
    assert.strictEqual(w.cleanPlayerName("🔥"), null);
    const member = (rolesHeld) => ({ user: { id: "u-sean", username: "monkeydsean" }, roles: rolesHeld });
    const held = () => Array.from(discord.memberRoles["u-sean"] || []);
    // pick Lakers, then switch to Warriors: exactly one 🏀 role at a time, created on demand
    let r = await interact({ type: 3, member: member([]), data: { custom_id: "fav:team", component_type: 2 } });
    assert.ok(r.body.data.flags === 64 && /conference/.test(r.body.data.content), "button asks East or West privately");
    r = await interact({ type: 3, member: member([]), data: { custom_id: "fav:conf:W", component_type: 2 } });
    assert.strictEqual(r.body.type, 7); assert.strictEqual(r.body.data.components[0].components[0].options.length, 15);
    r = await interact({ type: 3, member: member([]), data: { custom_id: "fav:team:W", component_type: 3, values: ["LAL"] } });
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.body.type, 7); assert.ok(/Lakers/.test(r.body.data.content) && /#552583/.test(r.body.data.content));
    let lakers = discord.roles.find((x) => x.name === "🏀 Lakers"); assert.ok(lakers && lakers.color === 0x552583);
    assert.deepStrictEqual(held(), [lakers.id]);
    r = await interact({ type: 3, member: member(held()), data: { custom_id: "fav:team:W", component_type: 3, values: ["GS"] } });
    const dubs = discord.roles.find((x) => x.name === "🏀 Warriors");
    assert.deepStrictEqual(held(), [dubs.id], "old team role removed");
    // zone
    r = await interact({ type: 3, member: member(held()), data: { custom_id: "fav:zone", component_type: 3, values: ["pacific"] } });
    assert.ok(/Pacific/.test(r.body.data.content)); assert.ok(held().length === 2);
    // pings: multi-select, clearing removes all
    r = await interact({ type: 3, member: member(held()), data: { custom_id: "fav:ping", component_type: 3, values: ["news", "shams"] } });
    assert.ok(/News.*Shams|Shams.*News/.test(r.body.data.content)); assert.strictEqual(held().length, 4);
    r = await interact({ type: 3, member: member(held()), data: { custom_id: "fav:ping", component_type: 3, values: [] } });
    assert.ok(/All pings off/.test(r.body.data.content)); assert.strictEqual(held().length, 2);
    // favorite player: button opens a modal, submit creates ⭐ role, resubmit swaps it
    r = await interact({ type: 3, member: member(held()), data: { custom_id: "fav:player", component_type: 2 } });
    assert.strictEqual(r.body.type, 9); assert.strictEqual(r.body.data.custom_id, "fav:player:modal");
    r = await interact({ type: 5, member: member(held()), data: { custom_id: "fav:player:modal", components: [{ type: 1, components: [{ type: 4, custom_id: "name", value: "jalen johnson" }] }] } });
    assert.ok(/Jalen Johnson/.test(r.body.data.content)); assert.ok(discord.roles.some((x) => x.name === "⭐ Jalen Johnson"));
    r = await interact({ type: 5, member: member(held()), data: { custom_id: "fav:player:modal", components: [{ type: 1, components: [{ type: 4, custom_id: "name", value: "Nikola Jokic" }] }] } });
    const stars = held().map((id) => discord.roles.find((x) => x.id === id).name).filter((n) => n.startsWith("⭐"));
    assert.deepStrictEqual(stars, ["⭐ Nikola Jokic"]);
    r = await interact({ type: 5, member: member(held()), data: { custom_id: "fav:player:modal", components: [{ type: 1, components: [{ type: 4, custom_id: "name", value: "!!!" }] }] } });
    assert.ok(/doesn't look like a name/.test(r.body.data.content));
  }

  // Parsers
  {
    const t = discordFn._test;
    assert.deepStrictEqual(t.parseOptions("Yes | No"), ["Yes", "No"]);
    assert.deepStrictEqual(t.parseOptions("a, b, c"), ["a", "b", "c"]);
    assert.strictEqual(t.parseCloses(""), null);
    assert.strictEqual(t.parseCloses("banana"), undefined);
    const h = new Date(t.parseCloses("6h")) - Date.now();
    assert.ok(h > 5.9 * 36e5 && h < 6.1 * 36e5);
  }

  console.log("all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
