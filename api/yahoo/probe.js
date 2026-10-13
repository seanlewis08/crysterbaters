// Read-only peek at any Yahoo Fantasy GET for the signed-in member (their own token, their
// own data); used to check what the API offers before a feature is built. Nothing stored.
const L = require("./_lib");
module.exports = async (req, res) => {
  try {
    const s = await L.session(req, res);
    if (!s) return L.json(res, 401, { error: "not_connected" });
    const q = new URL(req.url, L.origin(req)).searchParams;
    const path = String(q.get("path") || "");
    if (!/^\/[a-z0-9_.,;=\/-]+$/i.test(path)) return L.json(res, 400, { error: "bad path" });
    const j = await L.yahoo(s, path);
    L.json(res, 200, { raw: JSON.stringify(j).slice(0, Number(q.get("n")) || 4000) });
  } catch (e) { L.json(res, e.code === 401 ? 401 : 500, { error: e.message }); }
};
