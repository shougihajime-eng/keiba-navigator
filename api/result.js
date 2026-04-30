"use strict";
const { readResult, listResults } = require("../lib/finalize");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const url = new URL(req.url, "http://localhost");
  const raceId = url.searchParams.get("raceId");
  if (raceId) {
    const r = readResult(raceId);
    if (!r) return res.status(404).json({ ok: false, reason: "結果データなし(JV-Link接続後に取得)" });
    return res.status(200).json({ ok: true, result: r });
  }
  return res.status(200).json({ ok: true, available: listResults() });
};
