// One-shot: registers the slash commands with Discord.
// GET https://crysterbaters.com/api/discord-register?key=<SYNC_SECRET>
// Re-run whenever the command definitions below change.
"use strict";

const dc = require("./_lib/discord");


const COMMANDS = [
  {
    name: "link",
    description: "Link your Discord account to your Crysterbaters team",
    // Names come live from Yahoo via autocomplete (api/_lib/yahoo-server.js),
    // so a rename in Yahoo shows up here immediately.
    options: [{
      type: 3, name: "team", description: "Your team (start typing — names come from Yahoo)", required: true,
      autocomplete: true,
    }],
  },
  { name: "unlink", description: "Unlink your Discord account from your team" },
  { name: "whoami", description: "Which team am I linked to?" },
  {
    name: "poll",
    description: "Ask the league a question (shows up here and on the site)",
    options: [
      { type: 3, name: "question", description: "The question (max 300 chars)", required: true, max_length: 300 },
      { type: 3, name: "options", description: "Choices separated by | — e.g. Yes | No | Abstain (2–12)", required: true },
      {
        type: 3, name: "visibility", description: "Who can see who voted for what", required: false,
        choices: [
          { name: "Named — everyone sees who voted what", value: "named" },
          { name: "Anonymous — totals only, ever", value: "anon" },
          { name: "Anonymous until it closes", value: "anon_until_close" },
        ],
      },
      { type: 3, name: "closes", description: "Auto-close after e.g. 6h, 2d, 90m (leave blank to close by hand)", required: false },
    ],
  },
];

module.exports = async (req, res) => {
  const secret = process.env.SYNC_SECRET || "";
  const key = (req.query && req.query.key) || "";
  if (!secret || key !== secret) return res.status(401).send("nope");
  if (!process.env.DISCORD_APP_ID) return res.status(500).send("DISCORD_APP_ID not set");
  try {
    const out = await dc.registerCommands(process.env.DISCORD_APP_ID, COMMANDS);
    return res.status(200).json({ registered: out.map((c) => c.name) });
  } catch (e) {
    return res.status(500).json({ error: e.message, detail: e.data });
  }
};

module.exports.COMMANDS = COMMANDS;
