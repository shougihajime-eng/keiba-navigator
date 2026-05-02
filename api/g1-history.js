"use strict";
const { readG1, listG1 } = require("../lib/g1_history");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=3600");
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id");
  if (id) {
    const r = readG1(id);
    if (!r) return res.status(404).json({ ok: false, reason: "G1履歴データなし(JV-Link接続後に集計)" });
    return res.status(200).json({ ok: true, history: r });
  }
  return res.status(200).json({ ok: true, available: listG1() });
};
