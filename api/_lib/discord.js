// Discord REST helpers + interaction signature check. No dependencies:
// Node's crypto verifies Ed25519 natively once the raw 32-byte public key
// is wrapped in a SPKI envelope.
"use strict";

const crypto = require("crypto");

const API = "https://discord.com/api/v10";
const TOKEN = () => process.env.DISCORD_BOT_TOKEN || "";

// Interaction types / response types (subset).
const IT = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
const RT = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
};
const EPHEMERAL = 1 << 6;

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifySignature(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    const msg = Buffer.concat([Buffer.from(String(timestamp)), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
    return crypto.verify(null, msg, key, Buffer.from(signatureHex, "hex"));
  } catch (_) {
    return false;
  }
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bot " + TOKEN(),
      "Content-Type": "application/json",
      "User-Agent": "CrysterbatersPolls (https://crysterbaters.com, 1.0)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
  if (!res.ok) {
    const err = new Error("Discord " + method + " " + path + " → " + res.status + ": " + (data && data.message ? data.message : text));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const postMessage = (channelId, payload) => api("POST", "/channels/" + channelId + "/messages", payload);
const editMessage = (channelId, messageId, payload) => api("PATCH", "/channels/" + channelId + "/messages/" + messageId, payload);
const deleteMessage = (channelId, messageId) => api("DELETE", "/channels/" + channelId + "/messages/" + messageId);
const registerCommands = (appId, commands) => api("PUT", "/applications/" + appId + "/commands", commands);

// Follow-up for an interaction we already acknowledged (uses the app id +
// interaction token, not the bot token).
async function followUp(appId, token, payload) {
  const res = await fetch(API + "/webhooks/" + appId + "/" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

// Discord's relative timestamp markup, e.g. "closes <t:1760738400:R>".
const ts = (iso, style) => "<t:" + Math.floor(new Date(iso).getTime() / 1000) + ":" + (style || "R") + ">";

module.exports = {
  IT, RT, EPHEMERAL,
  verifySignature, api, postMessage, editMessage, deleteMessage, registerCommands, followUp, ts,
};
