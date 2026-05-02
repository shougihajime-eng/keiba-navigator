"use strict";
const { finalizeBatch } = require("../lib/finalize");

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, reason: "POST only" });
  }
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    const bets = Array.isArray(payload.bets) ? payload.bets : [];
    const updates = finalizeBatch(bets);
    return res.status(200).json({ ok: true, count: updates.length, updates });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
